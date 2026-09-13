// 极光题库 - 新学科全量爬取器 v2 (断点续爬 + 保守限流)
// 用法(三选一传 token, git-bash 下 env 不进 node 进程, 优先用 argv 或文件):
//   1) node jiguang_new_subjects_crawl.mjs 'eyJ...完整JWT'
//   2) JIGUANG_TOKEN=有效JWT node jiguang_new_subjects_crawl.mjs
//   3) 把 token 写入当前目录 jiguang_token.txt
// 默认爬全部 TARGETS; 可追加目录名参数只爬指定(如 '../题源数据/大四/儿科学')
// 支持断点: 每章完成后立即写文件, 重跑自动跳过已完成章节与已有题目id
import fs from 'fs';
import https from 'https';
import net from 'net';
import tls from 'tls';
import path from 'path';

function resolveToken() {
  const i = process.argv.findIndex(a => typeof a === 'string' && a.startsWith('eyJ') && a.split('.').length === 3);
  if (i >= 0) { const t = process.argv[i]; process.argv.splice(i, 1); return t; } // 从 argv 取并剔除, 避免干扰 TARGETS 过滤
  if (process.env.JIGUANG_TOKEN) return process.env.JIGUANG_TOKEN;
  const f = path.join(process.cwd(), 'jiguang_token.txt');
  if (fs.existsSync(f)) { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) {} }
  return null;
}
const TOKEN = resolveToken();
if (!TOKEN) { console.error('错误: 需要有效的 JWT (命令行参数 / 环境变量 JIGUANG_TOKEN / jiguang_token.txt 文件)'); process.exit(1); }
const BASE = 'https://api.ji-guang.top/api/v1';
const CONCURRENCY = 1;           // 串行: 极光风控严格, 绝不并发
const SOCK_TIMEOUT = 30000;
let REQ_GAP = 8000;              // 当前自适应请求间隔 ms (基础值; AIMD 动态调整; 命令行 gap=N 覆盖。09-08 代理生效后由12000下调)
const CH_GAP_MIN = 500;          // 章节间延时 ms (用户约束≤5s, 压到0.5-2s)
const CH_GAP_MAX = 2000;
const BACKOFF_BASE = 30000;      // 429 指数退避基数 ms (原固定30s×3 是典型机器特征)
const BACKOFF_CAP = 300000;      // 退避上限 300s
const RETRY_N = 3;               // 429/网络重试次数
let COOL_EVERY_MIN = 999999;       // 冷却触发点随机范围 (原固定50 是周期脉冲) [BURST模式需重赋值, 改let]
let COOL_EVERY_MAX = 75;
const COOL_SEC_MIN = 120;        // 冷却时长随机范围 s (原固定180)
const COOL_SEC_MAX = 300;
function parseArg(name, def) {
  const i = process.argv.findIndex(a => typeof a === 'string' && a.startsWith(name + '='));
  if (i >= 0) { const v = process.argv[i].split('=')[1]; process.argv.splice(i, 1); return v; } // 从 argv 取并剔除, 规避 git-bash env 不进 node 的问题
  const ev = process.env[name.toUpperCase()];
  return ev !== undefined ? ev : def;
}
const REQ_BUDGET = parseInt(parseArg('budget', '250')); // 本轮全局请求预算 (命令行 budget=N 或 env BUDGET 可覆盖; 爬大科目需 >450)
const TOKEN_CAP = parseInt(parseArg('cap', '0'), 10) || 0;  // 每 token 题数上限(多账号轮换用); 0=不限
REQ_GAP = parseInt(parseArg('gap', String(REQ_GAP)));   // parseArg 定义在上方常量之后才生效, 故此处二次赋值
let reqCount = 0;                // 本轮已发请求数

// ===== 09-08 拟人化改造: 去周期化 + AIMD 自适应 + 拟人双峰 + 慢启动 =====
let GAP_MIN = 5000;            // AIMD 加速下限 ms (09-08 实测: 降到5.2s就撞429, 安全地板≈8s)
const GAP_MAX = 60000;           // AIMD 减速上限 ms
let JITTER_MIN = 0.7;          // 间隔抖动下限倍率 (锁在3.5-5s区间, 满足单题≤5s硬约束)
let JITTER_MAX = 1.0;          // 抖动上限倍率 (实际间隔 = REQ_GAP×[0.7,1.0] = 3500-5000ms)
let LONG_PAUSE_P = 0;       // 拟人双峰: 5% 概率进入"看解析/走神"停顿 (限速下停顿纯属浪费, 由8%下调)
const LONG_PAUSE_MIN = 12000;    // 真人单题节奏: 读题+思考+作答+看解析, 撑死半分钟
const LONG_PAUSE_MAX = 28000;    // 上限 28s (原 40-300s 严重脱离真实用户行为)
const AIMD_SUCCESS_N = 12;       // 连续成功N次后加性增(加速; 原20次收敛太慢, 代理生效后下调)
const AIMD_INC = 0.9;            // gap × 0.9
const AIMD_DEC = 2.0;            // 撞429: gap × 2 (乘性减, TCP 拥塞控制同款)
const SLOW_START_N = 10;         // 冷却/长退避后前N个请求间隔翻倍, 渐进恢复(避免速率突变)
const FAIL_SOFT = 5;             // 连续失败至此进入长退避(原设定: 直接中止整个学科)
const FAIL_HARD = 3;             // 长退避轮次上限, 超过才中止学科
const FAIL_BACKOFF_MIN = 300000; // 长退避 5min
const FAIL_BACKOFF_MAX = 900000; // 长退避 15min
const FAIL_EXIT = FAIL_SOFT;     // 兼容旧引用
const PAGE_SIZE = 100;           // 章节列表分页大小 (不用limit=10000大分页, 疑似风控特征)

// ===== BURST 猛拉模式 (用户策略: 200就猛拉, 撞429立刻停, 冷却后接着猛拉) =====
// 触发: 命令行带 'burst' 参数 或 环境变量 BURST=1
// 行为: 间隔压到200ms拉满200窗口; 一旦429立即写盘+退出码42, 绝不空转烧配额(由轮询器负责冷却后续拉)
const BURST = process.argv.includes('burst') || process.env.BURST === '1';
if (BURST) {
  REQ_GAP = 200; GAP_MIN = 200; JITTER_MIN = 1.0; JITTER_MAX = 1.0;
  LONG_PAUSE_P = 0; COOL_EVERY_MIN = 999999; COOL_EVERY_MAX = 999999;
  console.log('🔥 BURST 猛拉模式: 间隔200ms, 撞429立即停(退出码42), 不在429上空转烧配额');
}

// UA 池: 每会话随机选一个并固定 (同账号频繁换 UA 反而异常)
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
];
const UA = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

// ===== 代理池 (IP 轮换, 对抗 IP 级限流; 09-08 新增) =====
// 配置见 jiguang_proxies.json: mode = off(直连) / round(每请求轮换) / sticky(每章轮换)
const PROXY_FILE = path.join(process.cwd(), 'jiguang_proxies.json');
let PROXY_MODE = 'off', PROXIES = [];
try {
  if (fs.existsSync(PROXY_FILE)) {
    const pc = JSON.parse(fs.readFileSync(PROXY_FILE, 'utf8'));
    PROXY_MODE = pc.mode || 'off';
    PROXIES = Array.isArray(pc.proxies) ? pc.proxies.filter(p => p && p.port) : [];
  }
} catch (e) { console.log('⚠️ 代理配置读取失败, 走直连:', e.message.slice(0, 60)); }
let proxyIdx = 0;
const curProxy = () => (PROXY_MODE !== 'off' && PROXIES.length) ? PROXIES[proxyIdx % PROXIES.length] : null;
function rotateProxy() { if (PROXIES.length > 1) proxyIdx++; }

// HTTP CONNECT 隧道 agent: 让 https.request 经由代理发出, 从而改变出口 IP
class TunnelAgent extends https.Agent {
  constructor(proxy) { super({ keepAlive: false, maxSockets: 1 }); this.proxy = proxy; }
  createConnection(options, cb) {
    const host = options.host || options.hostname;
    const port = options.port || 443;
    const s = net.connect({ host: this.proxy.host, port: this.proxy.port }, () => {
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let settled = false;
    const fail = e => { if (settled) return; settled = true; try { s.destroy(); } catch (x) {} cb(e); };
    s.once('data', d => {
      const head = d.toString();
      // 真 CONNECT 隧道只回 200 状态行; 带 body 的说明不是标准 HTTP 代理(如私有加密协议), 需排除
      if (!/^HTTP\/1\.[01] 200/.test(head)) return fail(new Error('代理CONNECT失败: ' + head.split('\r\n')[0]));
      settled = true;
      const t = tls.connect({ socket: s, servername: host }, () => cb(null, t));
      t.on('error', () => { try { s.destroy(); } catch (x) {} });
    });
    s.on('error', fail);
    s.setTimeout(30000, () => fail(new Error('代理连接超时')));
  }
}

// 运行时状态 (AIMD / 慢启动 / 冷却 / 可观测性)
const randRange = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(randRange(a, b + 1));
let consecOK = 0;                                        // AIMD 连续成功计数
let slowStartLeft = 0;                                   // 慢启动剩余请求数
let nextCoolAt = randInt(COOL_EVERY_MIN, COOL_EVERY_MAX); // 下次冷却触发点(随机)
let reqOK = 0, reqFail = 0;                              // 成功率统计

// 09-08 更新检测: 全站 59 学科, 本地 51; 9 科"更新", 8 科 VIP 或虚假缺口, 仅 外科学（test）真实可爬
// 真正可爬: 外科学（test）(1906→3594, +1688, 27章, 此前标称1906时不可爬, 09-08 探测 success=true 章27 章总和3594)
// 标称虚高不爬: 儿童医院社区实习(标称262, 章总和仅244 = 本地, 历史多次实测0真实新增)
// VIP 不可爬: 影像+20 / 医学免疫学+110 / 病理学+1 / 传染病test+938 / 儿科学+2467 / 内科学test+2226 / 耳鼻咽喉+78
// 未爬 8 科全 VIP: 药理学2519 / 口腔1321 / 医学心理学698 / 中医492 / 寄生虫702 / 康复859 / 妇产科学3776 / 全科医学614
const TARGETS = [
  { dir: '../题源数据/大四/外科学（test）',   sid: 'e1e0517c-2371-4d39-84b7-816deda1d049' },
  // 09-14 更新检测: 全站 58 学科, 本地 51; 8 科有更新, 其中 影像/医学免疫学/病理学/耳鼻咽喉/儿科学/传染病test/内科学test/外科学test 全部已转 VIP(9-14 探测 success=false)
  // 新增学科 卫生法 539题/11章 探测 success=true -> 本次唯一可爬目标
  { dir: '../题源数据/大三/卫生法',           sid: '71edb456-de44-4a90-bf94-b661d5168ce1' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastReqAt = 0;
let RATE_LIMITED = false;          // BURST 模式: 一旦撞429置true, 所有后续请求立即拒绝, 交由外层写盘+退出码42
let TOKEN_CAP_HIT = false;         // 多账号轮换: 达每 token 题数上限后干净退出(码43)
let runAdded = 0;                  // 本轮累计新增题数(用于 cap 判定)
function makeRateLimitedErr() { const e = new Error('RATE_LIMITED_猛拉停'); e.rateLimited = true; return e; }

// AIMD 拥塞控制: 连续成功缓慢加速, 撞429立即减速 —— 让账号自己告诉我它的配额, 而非人工猜
function onSuccess() {
  consecOK++;
  if (consecOK >= AIMD_SUCCESS_N) {
    consecOK = 0;
    const old = REQ_GAP;
    REQ_GAP = Math.max(GAP_MIN, REQ_GAP * AIMD_INC);
    if (Math.abs(REQ_GAP - old) > 100) console.log(`   📈 AIMD加速: 间隔 ${(old / 1000).toFixed(1)}s -> ${(REQ_GAP / 1000).toFixed(1)}s`);
  }
}
function onThrottle() {
  consecOK = 0;
  const old = REQ_GAP;
  REQ_GAP = Math.min(GAP_MAX, REQ_GAP * AIMD_DEC);
  console.log(`   📉 AIMD减速: 间隔 ${(old / 1000).toFixed(1)}s -> ${(REQ_GAP / 1000).toFixed(1)}s`);
}
// 指数退避 + full jitter (替代固定 30s×3)
function backoffWait(left) {
  const n = RETRY_N - left;                                   // 已重试次数 0,1,2
  const raw = Math.min(BACKOFF_CAP, BACKOFF_BASE * Math.pow(2, n));
  return Math.round(raw * randRange(0.5, 1.0));
}

async function throttle() {
  let gap = REQ_GAP * randRange(JITTER_MIN, JITTER_MAX);      // 抖动: 消除固定周期
  if (slowStartLeft > 0) { gap *= 2; slowStartLeft--; }        // 慢启动: 冷却后渐进恢复
  // 拟人双峰: 小概率进入"看解析/走神"的长停顿, 比单纯随机更像真人刷题
  if (Math.random() < LONG_PAUSE_P) {
    const lp = randRange(LONG_PAUSE_MIN, LONG_PAUSE_MAX);
    console.log(`   ☕ 拟人停顿 ${(lp / 1000).toFixed(0)}s`);
    await sleep(lp);
    lastReqAt = Date.now();
  }
  const wait = gap - (Date.now() - lastReqAt);
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
}

function req(p, retry = RETRY_N) {
  if (RATE_LIMITED) return Promise.reject(makeRateLimitedErr());
  return new Promise((resolve, reject) => {
    const attempt = async (n) => {
      await throttle();
      reqCount++;
      if (reqCount > REQ_BUDGET) { const e = new Error('REQ_BUDGET_EXHAUSTED'); e.budget = true; reject(e); return; }
      const u = new URL(BASE + p);
      const px = curProxy();
      const opt = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json', 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, agent: px ? new TunnelAgent(px) : undefined };
      const r = https.request(opt, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', async () => {
          if (res.statusCode === 401) { reject(new Error('401 鉴权失败: token 无效或过期')); return; }
          if (res.statusCode === 429 || res.statusCode >= 500) {
            onThrottle();                                     // 乘性减: 立即降速并重置加速计数
            if (BURST) { RATE_LIMITED = true; reqFail++; reject(makeRateLimitedErr()); return; }  // 猛拉模式: 撞墙立即停, 不空转
            if (n > 0) { const w = backoffWait(n); console.log(`   🚨[${res.statusCode}] 退避${(w / 1000).toFixed(0)}s 剩余重试${n}...`); await sleep(w); return attempt(n - 1); }
            reqFail++; reject(new Error('限流重试耗尽: ' + res.statusCode)); return;
          }
          try {
            const j = JSON.parse(data);
            if (j.success === false && (j.error_code === 'HTTP_429' || j.code === 429)) {
              if (BURST) { RATE_LIMITED = true; reqFail++; reject(makeRateLimitedErr()); return; }  // 猛拉模式: 业务429立即停
              if (n > 0) { onThrottle(); const w = backoffWait(n); console.log(`   🚨[业务429] 退避${(w / 1000).toFixed(0)}s 剩余重试${n}...`); await sleep(w); return attempt(n - 1); }
              reqFail++; reject(new Error('业务429重试耗尽')); return;
            }
            if (j.success === false) { reject(new Error('业务错误: ' + (j.message || j.error_code))); return; }
            reqOK++; onSuccess();                             // 加性增: 连续成功缓慢加速
            if (PROXY_MODE === 'round') rotateProxy();         // round 模式: 每请求换一个出口 IP
            resolve(j);
          } catch (e) { reject(new Error('parse失败: ' + data.slice(0, 200))); }
        });
      });
      r.setTimeout(SOCK_TIMEOUT, () => r.destroy(new Error('请求超时 ' + SOCK_TIMEOUT + 'ms: ' + p)));
      r.on('error', async e => { if (n > 0) { console.log(`   ⚠️网络错误 随机退避 剩余重试${n}...`); await sleep(randRange(6000, 15000)); return attempt(n - 1); } reject(e); });
      r.end();
    };
    attempt(retry);
  });
}

async function pool(items, worker, concurrency) {
  let idx = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// 抗文件锁(杀软/云同步/索引可能锁目标文件): tmp+rename 原子写, 失败等 3s 重试 ×8
async function safeRead(file) {
  for (let i = 0; i < 8; i++) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (e) { if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { console.log(`   🔒读盘锁重试(${i + 1}/8): ${path.basename(file)}`); await sleep(3000); continue; } throw e; }
  }
  throw new Error('读盘重试耗尽: ' + file);
}
async function safeWrite(file, data) {
  const tmp = file + '.' + Date.now() + '.' + process.pid + '.tmp';
  for (let i = 0; i < 6; i++) {
    try {
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.writeFileSync(file, data, 'utf8'); return; } catch (e2) {}
        console.log(`   🔒写盘锁重试(${i + 1}/6): ${path.basename(file)}`); await sleep(5000); continue;
      }
      throw e;
    }
  }
  // 写盘失败不中止: tmp 已保留完整数据, 下次启动 loadExisting 自动恢复
  console.log(`   ⚠️ 写盘超时未成功, tmp已保留待恢复: ${path.basename(tmp)}`);
}

async function writeTxt(file, result) {
  const lines = [];
  lines.push('# ' + result.subject + '（极光题库导出）');
  lines.push('导出时间: ' + new Date().toLocaleString('zh-CN'));
  lines.push('总题数: ' + result.chapters.reduce((a, c) => a + c.count, 0));
  lines.push('');
  let gq = 0;
  for (const ch of result.chapters) {
    lines.push('========================================');
    lines.push(`第${ch.sort_order}章 ${ch.name}（${ch.count}题）`);
    lines.push('========================================');
    for (const q of ch.questions) {
      gq++;
      lines.push('');
      lines.push(`【${gq}】(${q.display_type || ''}) ${q.content || ''}`);
      if (q.options && typeof q.options === 'object') for (const k of Object.keys(q.options)) lines.push(`  ${k}. ${q.options[k]}`);
      if (q.correct_answer) lines.push(`答案: ${q.correct_answer}`);
      const exp = q.explanation || q.ai_explanation || '';
      if (exp) lines.push(`解析: ${exp.replace(/\n+/g, ' ').slice(0, 600)}`);
    }
  }
  await safeWrite(file, lines.join('\n'));
}

async function loadExisting(dir, subjName) {
  const file = path.join(process.cwd(), dir, '1.题库', '极光_' + subjName + '.json');
  // 优先从最新 tmp 恢复(写盘 rename 失败时的残留, 数据可能比正式文件新)
  try {
    const dirp = path.dirname(file), base = path.basename(file);
    const tmps = fs.readdirSync(dirp).filter(f => f.startsWith(base + '.') && f.endsWith('.tmp')).sort();
    if (tmps.length) {
      const tp = path.join(dirp, tmps[tmps.length - 1]);
      const td = JSON.parse(fs.readFileSync(tp, 'utf8'));
      const tn = td.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0);
      let useTmp = !fs.existsSync(file);
      if (!useTmp) {
        const fd = JSON.parse(await safeRead(file));
        const fn = fd.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0);
        useTmp = tn >= fn;
      }
      if (useTmp) { console.log(`   ♻️ 从tmp恢复 ${tmps[tmps.length - 1]} (${tn}题)`); return { file, data: td }; }
    }
  } catch (e) { console.log('   ⚠️ tmp恢复失败(忽略):', e.message.slice(0, 80)); }
  if (fs.existsSync(file)) {
    try { return { file, data: JSON.parse(await safeRead(file)) }; }
    catch (e) { console.log('   ⚠️ 已有文件损坏, 重建:', file); }
  }
  return { file, data: null };
}

async function crawlOne(t) {
  const subj = (await req('/user/subjects/' + t.sid)).data;
  console.log(`\n########## [${subj.name}] 全站 ${subj.chapters.length} 章, 标称 ${subj.total_questions} 题 ##########`);
  const { file, data } = await loadExisting(t.dir, subj.name);
  const result = data || { subject: subj.name, subjectId: subj.id, chapters: [] };
  const doneIds = new Set();
  for (const c of result.chapters) for (const q of c.questions || []) doneIds.add(q.id);
  let grand = 0, grandFail = 0;
  for (const ch of subj.chapters) {
    if (RATE_LIMITED) break;                              // 猛拉模式: 撞429后不再开新章, 统一写盘退出
    let slot = result.chapters.find(c => c.id === ch.id);
    if (!slot) { slot = { id: ch.id, name: ch.name, sort_order: ch.sort_order, count: 0, questions: [] }; result.chapters.push(slot); }
    // 章节级断点修正: 不再 early-continue 跳过"本地有题"的章 —— 本地有题 ≠ 完整(如第21章本地17题/线上94题会漏爬77题)。
    // 统一走下方 list 分支: 拉全量 ids 后用 doneIds 过滤已有题仅补缺失; 已满章 newIds 为空则不发 question 请求(仅多1个 list 配额, 换取不漏爬)。
    let ids = [];
    for (let tries = 0; tries < 4; tries++) {
      try {
        // 分页拉取章节题目id (不用limit=10000大分页, 疑似风控特征)
        ids = [];
        let skip = 0;
        while (true) {
          const list = await req(`/user/chapters/${ch.id}?mode=practice&skip=${skip}&limit=${PAGE_SIZE}`);
          const page = (list.data && list.data.questions || []).map(q => q.id).filter(Boolean);
          ids.push(...page);
          const total = (list.data && list.data.pagination && list.data.pagination.total) || 0;
          skip += page.length;
          if (page.length === 0 || skip >= total || skip >= 5000) break;
          await sleep(REQ_GAP * randRange(JITTER_MIN, JITTER_MAX));
        }
        if (ids.length > 0) break;
        console.log(`   ⚠️ 章节列表返回0 重试(${tries + 1}/4)...`); await sleep(randRange(6000, 15000));
      } catch (e) {
        if (e.rateLimited) { RATE_LIMITED = true; break; }   // 猛拉模式: 列表也429, 跳出重试直接走退出
        if (tries === 3) throw e;
        console.log(`   ⚠️ 章节列表请求失败 重试(${tries + 1}/4): ${e.message.slice(0, 60)}`); await sleep(randRange(6000, 15000));
      }
    }
    const newIds = ids.filter(id => !doneIds.has(id));
    let failed = 0, added = 0, sinceCool = 0, hardRound = 0;
    if (newIds.length) {
      let n = 0;
      await pool(newIds, async (id) => {
        if (TOKEN_CAP_HIT) return;   // 严格尊重每token上限: 达cap后跳过本章剩余题目, 不压过上限
        try {
          const det = await req('/user/questions/' + id);
          if (det.success && det.data && det.data.content) { slot.questions.push(det.data); doneIds.add(id); added++; runAdded++; if (TOKEN_CAP > 0 && runAdded >= TOKEN_CAP) TOKEN_CAP_HIT = true; }
          else failed++;
        } catch (e) {
          if (e.budget) return;  // 预算耗尽: 正常结束不计数(避免误触发"疑似限流")
          if (e.rateLimited) return;  // 猛拉模式: 撞429, 交给外层统一写盘+退出码42
          failed++; if (failed <= 3) console.log('   失败:', id.slice(0, 8), e.message.slice(0, 50));
          // 连续失败过多: 先长退避给账号恢复机会(原设定直接中止学科, 导致频繁重启又快速撞墙)
          if (failed >= FAIL_SOFT) {
            hardRound++;
            slot.count = slot.questions.length;
            await safeWrite(file, JSON.stringify(result, null, 2));
            if (hardRound > FAIL_HARD) {
              console.log(`   🛑 连续失败${failed}题且已长退避${FAIL_HARD}次仍失败, 已写盘${slot.count}题, 中止当前学科`);
              throw new Error('连续失败过多, 疑似账号限流');
            }
            const w = randRange(FAIL_BACKOFF_MIN, FAIL_BACKOFF_MAX);
            onThrottle();                                      // 同步降速
            console.log(`   🛑 连续失败${failed}题 -> 长退避 ${(w / 60000).toFixed(1)}min (第${hardRound}/${FAIL_HARD}次), 已写盘${slot.count}题`);
            await sleep(w);
            failed = 0; slowStartLeft = SLOW_START_N;          // 重置计数, 给账号恢复机会
          }
        }
        n++; sinceCool++;
        if (n % 30 === 0) console.log(`   ...${n}/${newIds.length}`);
        // 主动冷却: 触发点与时长均随机 (原固定 50请求/180s 是周期脉冲); 顺带写盘防丢
        if (sinceCool >= nextCoolAt) {
          slot.count = slot.questions.length;
          await safeWrite(file, JSON.stringify(result, null, 2));
          const cs = randInt(COOL_SEC_MIN, COOL_SEC_MAX);
          console.log(`   💤 冷却 ${cs}s (已${n}请求, 已写盘${slot.count}题, 当前间隔${(REQ_GAP / 1000).toFixed(1)}s)`);
          await sleep(cs * 1000); sinceCool = 0;
          nextCoolAt = randInt(COOL_EVERY_MIN, COOL_EVERY_MAX);
          slowStartLeft = SLOW_START_N;                        // 慢启动: 渐进恢复, 避免速率突变
        }
      }, CONCURRENCY);
    }
    if (TOKEN_CAP_HIT) break;   // 达每 token 上限: 跳出章节循环, 统一写盘+退出码43
    slot.count = slot.questions.length;
    grand += added; grandFail += failed;
    // 断点: 每章完成立即写盘
    await safeWrite(file, JSON.stringify(result, null, 2));
    await writeTxt(file.replace(/\.json$/, '.txt'), result);
    const rate = (reqOK + reqFail) > 0 ? (reqOK / (reqOK + reqFail) * 100).toFixed(0) : '-';
    console.log(`   ${ch.name}: +${added} (失败${failed}) -> 共 ${slot.count}  [间隔${(REQ_GAP / 1000).toFixed(1)}s 成功率${rate}% 累计${reqOK + reqFail}请求]`);
    if (PROXY_MODE === 'sticky') rotateProxy();                // sticky 模式: 每章换一个出口 IP
    await sleep(randRange(CH_GAP_MIN, CH_GAP_MAX));
  }
  if (RATE_LIMITED) {                                       // 猛拉模式: 撞429统一写盘+退出码42, 交由轮询器冷却后续拉
    await safeWrite(file, JSON.stringify(result, null, 2));
    console.log(`   🚨 撞429, 已写盘(${result.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0)}题), 退出码42 交由轮询器冷却`);
    process.exit(42);
  }
  if (TOKEN_CAP_HIT) {                                      // 多账号轮换: 达每 token 题数上限, 干净退出码43, 交由轮询器换下一个 token
    await safeWrite(file, JSON.stringify(result, null, 2));
    console.log(`   🎯 达本次 token 题数上限(${TOKEN_CAP}), 已写盘(${result.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0)}题), 退出码43 交由轮询器换 token`);
    process.exit(43);
  }
  console.log(`✅ [${subj.name}] 本次新增 ${grand} 题 (失败${grandFail}), 共 ${result.chapters.reduce((a, c) => a + c.count, 0)} 题 -> ${file}`);
  return grand;
}

async function main() {
  let targets = TARGETS;
  const args = process.argv.slice(2);
  if (args.length) targets = TARGETS.filter(t => args.some(a => t.dir.includes(a)));
  console.log(`=== 新学科全量爬取启动: ${targets.length} 个学科 (并发${CONCURRENCY}, 初始间隔${REQ_GAP}ms, 抖动${JITTER_MIN}-${JITTER_MAX}x, AIMD区间${GAP_MIN / 1000}-${GAP_MAX / 1000}s, 长停顿${LONG_PAUSE_P * 100}%) ===`);
  console.log(`    代理池: ${PROXY_MODE === 'off' ? '关闭(直连)' : `${PROXY_MODE} 模式, ${PROXIES.length} 个出口`}${PROXIES.length && PROXY_MODE !== 'off' ? ' -> ' + PROXIES.map(p => p.host + ':' + p.port).join(', ') : ''}`);
  let total = 0;
  for (const t of targets) {
    try { total += await crawlOne(t); }
    catch (e) {
      if (e.budget) { console.log(`⏹ 本轮请求预算 ${REQ_BUDGET} 已用尽, 提前结束本轮(冷静期后继续)`); return; }
      console.error(`X [${t.dir}] 失败: ${e.message} (继续下一个)`);
    }
  }
  console.log(`\n========== 全部结束，本次共新增 ${total} 题 ==========`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
