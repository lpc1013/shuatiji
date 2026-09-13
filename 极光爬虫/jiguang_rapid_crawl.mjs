// 极光题库 - 封禁前快速爬取器 (2026-08-11)
// 用户决策: 放弃慢速保命, 高并发在封禁前最大化吞吐
// 并发20 + 无节流 + 无预算限制, 每20题写盘防丢, 连续失败15题即停(封禁信号)
// 用法: JIGUANG_TOKEN=有效JWT node jiguang_rapid_crawl.mjs [学科名...]
import fs from 'fs';
import https from 'https';
import path from 'path';

const TOKEN = process.env.JIGUANG_TOKEN;
if (!TOKEN) { console.error('错误: 需要有效的 JWT 环境变量 JIGUANG_TOKEN'); process.exit(1); }
const BASE = 'https://api.ji-guang.top/api/v1';
const CONCURRENCY = 5;           // 并发5: 20并发实测仅+5题就封, 降并发探更大窗口
const SOCK_TIMEOUT = 20000;
const REQ_GAP = 0;               // 不节流
const RETRY429_WAIT = 20000;     // 429 退避(只退1次, 封禁前多爬一点)
const RETRY_N = 1;               // 429/网络重试1次
const WRITE_EVERY = 20;          // 每爬N题写盘(防封禁丢数据)
const FAIL_EXIT = 15;            // 连续失败N题退出(封禁信号)
const PAGE_SIZE = 100;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TARGETS = [
  { dir: '../题源数据/大一/军事理论',         sid: 'b5f5dc43-7e55-4771-bc1b-d85460bbbd93' },
  { dir: '../题源数据/大四/外科学（test）', sid: 'e1e0517c-2371-4d39-84b7-816deda1d049' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastReqAt = 0;
async function throttle() {
  const wait = REQ_GAP - (Date.now() - lastReqAt);
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
}

function req(p, retry = RETRY_N) {
  return new Promise((resolve, reject) => {
    const attempt = async (n) => {
      await throttle();
      const u = new URL(BASE + p);
      const opt = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json', 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } };
      const r = https.request(opt, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', async () => {
          if (res.statusCode === 401) { reject(new Error('401 token失效')); return; }
          if (res.statusCode === 429 || res.statusCode >= 500) {
            if (n > 0) { await sleep(RETRY429_WAIT); return attempt(n - 1); }
            reject(new Error('429')); return;
          }
          try {
            const j = JSON.parse(data);
            if (j.success === false && (j.error_code === 'HTTP_429' || j.code === 429) && n > 0) { await sleep(RETRY429_WAIT); return attempt(n - 1); }
            if (j.success === false) { reject(new Error('业务错误: ' + (j.message || j.error_code))); return; }
            resolve(j);
          } catch (e) { reject(new Error('parse失败: ' + data.slice(0, 100))); }
        });
      });
      r.setTimeout(SOCK_TIMEOUT, () => r.destroy(new Error('超时 ' + p)));
      r.on('error', e => { if (n > 0) setTimeout(() => attempt(n - 1), 5000); else reject(e); });
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

// 抗文件锁: tmp+rename 原子写, 失败重试×6, 仍失败保留tmp(下次loadExisting恢复)
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
        await sleep(3000); continue;
      }
      throw e;
    }
  }
  console.log(`   ⚠️ 写盘未成功, tmp保留待恢复: ${path.basename(tmp)}`);
}

// 写盘串行化: 并发 worker 同时写同一文件会互相冲突, 用 promise 链排队
let writeChain = Promise.resolve();
function queuedWrite(file, data) {
  writeChain = writeChain.then(() => safeWrite(file, data));
  return writeChain;
}

async function loadExisting(dir, subjName) {
  const file = path.join(process.cwd(), dir, '1.题库', '极光_' + subjName + '.json');
  try {
    const dirp = path.dirname(file), base = path.basename(file);
    const tmps = fs.readdirSync(dirp).filter(f => f.startsWith(base + '.') && f.endsWith('.tmp')).sort();
    if (tmps.length) {
      const tp = path.join(dirp, tmps[tmps.length - 1]);
      const td = JSON.parse(fs.readFileSync(tp, 'utf8'));
      const tn = td.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0);
      let useTmp = !fs.existsSync(file);
      if (!useTmp) {
        const fd = JSON.parse(fs.readFileSync(file, 'utf8'));
        useTmp = tn >= fd.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0);
      }
      if (useTmp) { console.log(`   ♻️ 从tmp恢复 ${tmps[tmps.length - 1]} (${tn}题)`); return { file, data: td }; }
    }
  } catch (e) { console.log('   ⚠️ tmp恢复失败:', e.message.slice(0, 60)); }
  if (fs.existsSync(file)) {
    try { return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
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
    let slot = result.chapters.find(c => c.id === ch.id);
    if (!slot) { slot = { id: ch.id, name: ch.name, sort_order: ch.sort_order, count: 0, questions: [] }; result.chapters.push(slot); }
    let ids = [];
    try {
      let skip = 0;
      while (true) {
        const list = await req(`/user/chapters/${ch.id}?mode=practice&skip=${skip}&limit=${PAGE_SIZE}`);
        const page = (list.data && list.data.questions || []).map(q => q.id).filter(Boolean);
        ids.push(...page);
        const total = (list.data && list.data.pagination && list.data.pagination.total) || 0;
        skip += page.length;
        if (page.length === 0 || skip >= total || skip >= 5000) break;
      }
    } catch (e) { console.log(`   ⚠️ 章节列表失败: ${e.message.slice(0, 40)}`); }
    const newIds = ids.filter(id => !doneIds.has(id));
    let failed = 0, added = 0, sinceWrite = 0;
    if (newIds.length) {
      let n = 0;
      await pool(newIds, async (id) => {
        try {
          const det = await req('/user/questions/' + id);
          if (det.success && det.data && det.data.content) { slot.questions.push(det.data); doneIds.add(id); added++; }
          else failed++;
        } catch (e) {
          failed++; if (failed <= 5) console.log(`   失败: ${id.slice(0, 8)} ${e.message.slice(0, 40)}`);
          if (failed >= FAIL_EXIT) {
            slot.count = slot.questions.length;
            await queuedWrite(file, JSON.stringify(result, null, 2));
            console.log(`   🛑 连续失败${failed}题(疑似封禁), 已写盘${slot.count}题, 中止`);
            throw new Error('疑似封禁退出');
          }
        }
        n++; sinceWrite++;
        if (n % 50 === 0) console.log(`   ...${n}/${newIds.length} (累计+${added})`);
        // 频繁写盘防丢(封禁前每20题落盘一次)
        if (sinceWrite >= WRITE_EVERY) {
          slot.count = slot.questions.length;
          await queuedWrite(file, JSON.stringify(result, null, 2));
          sinceWrite = 0;
        }
      }, CONCURRENCY);
    }
    slot.count = slot.questions.length;
    grand += added; grandFail += failed;
    await queuedWrite(file, JSON.stringify(result, null, 2));
    console.log(`   ${ch.name}: +${added} (失败${failed}) -> 共 ${slot.count}`);
  }
  console.log(`✅ [${subj.name}] 本次新增 ${grand} 题 (失败${grandFail}), 共 ${result.chapters.reduce((a, c) => a + c.count, 0)} 题`);
  return grand;
}

async function main() {
  let targets = TARGETS;
  const args = process.argv.slice(2);
  if (args.length) targets = TARGETS.filter(t => args.some(a => t.dir.includes(a)));
  console.log(`=== 快速冲刺启动: ${targets.length} 个学科 (并发${CONCURRENCY}, 无节流) ===`);
  let total = 0;
  for (const t of targets) {
    try { total += await crawlOne(t); }
    catch (e) { console.error(`X [${t.dir}] 中止: ${e.message}`); break; }
  }
  console.log(`\n========== 本次共新增 ${total} 题 ==========`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
