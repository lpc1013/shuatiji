// 极光题库 - 增量补爬器 (激进高并发版)
// 用法:
//   JIGUANG_TOKEN=有效JWT node jiguang_update_crawl.mjs            # 只补审计报告里的"需更新"科
//   JIGUANG_TOKEN=有效JWT ALL=1 node jiguang_update_crawl.mjs      # 全量比对所有本地学科
//   JIGUANG_TOKEN=有效JWT ONLY='影像,病理学,儿童医院社区实习,耳鼻咽喉' node ...   # 只跑指定科
//   AGGRESSIVE=1 进一步提高并发(默认已激进)
// 注意: 2026-07-20 起 API 迁移到 https://api.ji-guang.top ，需有效 3 段 JWT。
import fs from 'fs';
import https from 'https';
import path from 'path';

const TOKEN = process.env.JIGUANG_TOKEN;
if (!TOKEN) { console.error('错误: 需要有效的 JWT 环境变量 JIGUANG_TOKEN'); process.exit(1); }
const BASE = 'https://api.ji-guang.top/api/v1';
const ALL = process.env.ALL === '1';
const AGG = process.env.AGGRESSIVE === '1';
const CONCURRENCY = AGG ? 24 : 12;   // 并发取题详情数
const SOCK_TIMEOUT = 20000;          // 单请求 socket 超时
let curConc = CONCURRENCY;

function req(p, retry = 4) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const u = new URL(BASE + p);
      const opt = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } };
      const r = https.request(opt, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 401) { reject(new Error('401 鉴权失败: token 无效或过期')); return; }
          if (res.statusCode === 429 || res.statusCode >= 500) {
            if (n > 0) { curConc = Math.max(3, Math.floor(curConc / 2)); console.log(`   🚨[${res.statusCode}] 降并发至${curConc} 退避8s...`); setTimeout(() => attempt(n - 1), 8000); return; }
            reject(new Error('限流重试耗尽: ' + res.statusCode)); return;
          }
          try {
            const j = JSON.parse(data);
            if (j.success === false && (j.error_code === 'HTTP_429' || j.code === 429) && n > 0) { curConc = Math.max(3, Math.floor(curConc / 2)); console.log('   🚨[业务限流] 降并发 退避8s...'); setTimeout(() => attempt(n - 1), 8000); return; }
            if (j.success === false) { reject(new Error('业务错误: ' + (j.message || j.error_code))); return; }
            resolve(j);
          } catch (e) { reject(new Error('parse失败: ' + data.slice(0, 200))); }
        });
      });
      r.setTimeout(SOCK_TIMEOUT, () => r.destroy(new Error('请求超时 ' + SOCK_TIMEOUT + 'ms: ' + p)));
      r.on('error', e => { if (n > 0) setTimeout(() => attempt(n - 1), 8000); else reject(e); });
      r.end();
    };
    attempt(retry);
  });
}

// 并发池
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function saveJson(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }

function writeTxt(file, result) {
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
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

async function updateOne(entry) {
  const file = entry.file;
  const sid = entry.sid;
  const local = readJson(file);
  const subject = (await req('/user/subjects/' + sid)).data;
  console.log(`\n########## [${local.subject}] 全站 ${subject.chapters.length} 章 ##########`);
  const result = local;
  const doneIds = new Set();
  for (const c of result.chapters) for (const q of c.questions) doneIds.add(q.id);
  let grandNew = 0;
  for (const ch of subject.chapters) {
    let slot = result.chapters.find(c => c.id === ch.id);
    if (!slot) { slot = { id: ch.id, name: ch.name, sort_order: ch.sort_order, count: 0, questions: [] }; result.chapters.push(slot); }
    // 软封禁自检: 若返回 0 但本地该章有题, 重试章节列表
    let ids = [];
    for (let tries = 0; tries < 3; tries++) {
      const list = await req(`/user/chapters/${ch.id}?mode=practice&skip=0&limit=10000`);
      ids = (list.data && list.data.questions || []).map(q => q.id).filter(Boolean);
      if (ids.length > 0 || (slot.questions.length === 0 && doneIds.size === 0)) break;
      if (ids.length === 0 && slot.questions.length > 0) { console.log(`   ⚠️ 章节列表返回0(疑似软封禁) 重试(${tries + 1}/3)...`); await sleep(5000); }
      else break;
    }
    const newIds = ids.filter(id => !doneIds.has(id));
    let added = 0, failed = 0;
    if (newIds.length) {
      let n = 0;
      await pool(newIds, async (id) => {
        try {
          const det = await req('/user/questions/' + id);
          if (det.success && det.data && det.data.content) { slot.questions.push(det.data); doneIds.add(id); added++; }
          else failed++;
        } catch (e) { failed++; if (failed <= 3) console.log('   失败:', id.slice(0, 8), e.message.slice(0, 50)); }
        n++;
        if (n % 50 === 0) console.log(`   ...${n}/${newIds.length} (并发${curConc})`);
      }, curConc);
    }
    slot.count = slot.questions.length;
    grandNew += added;
    console.log(`   ${ch.name}: +${added} (失败${failed}) -> 共 ${slot.count}`);
    await sleep(800); // 章间短歇, 避免过快
  }
  saveJson(file, result);
  writeTxt(file.replace(/\.json$/, '.txt'), result);
  const total = result.chapters.reduce((a, c) => a + c.count, 0);
  console.log(`✅ [${local.subject}] 本次新增 ${grandNew} 题，现共 ${total} 题 -> ${path.basename(file)}`);
  return grandNew;
}

async function main() {
  let targets;
  if (ALL) {
    targets = [];
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; walk(fp); }
        else if (/^极光_.*\.json$/.test(e.name)) { try { const d = readJson(fp); if (d.subjectId) targets.push({ file: fp, sid: d.subjectId, name: d.subject }); } catch (e) {} }
      }
    }
    walk(process.cwd());
  } else {
    const report = JSON.parse(fs.readFileSync('jiguang_update_report.json', 'utf8'));
    targets = (report.updated || []).map(u => ({ file: u.file, sid: u.sid, name: u.name }));
  }
  if (process.env.ONLY) {
    const only = process.env.ONLY.split(',').map(s => s.trim());
    targets = targets.filter(t => only.some(o => t.name.includes(o)));
    console.log('>>> ONLY 过滤生效:', targets.map(t => t.name).join(' | '));
  }
  console.log(`=== 激进补爬启动: ${targets.length} 个学科 (并发${CONCURRENCY}) ===`);
  let totalNew = 0;
  for (const t of targets) {
    try { totalNew += await updateOne(t); }
    catch (e) { console.error(`X [${t.name}] 失败: ${e.message} (继续下一个)`); }
  }
  console.log(`\n========== 全部结束，本次共新增 ${totalNew} 题 ==========`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
