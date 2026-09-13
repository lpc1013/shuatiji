// 极光题库 - 更新检测（只读，不下载题目详情）
// 用法: JIGUANG_TOKEN=xxx node jiguang_check_updates.mjs
import fs from 'fs';
import https from 'https';
import path from 'path';

// git-bash 下 `VAR=val node x.mjs` 的 env 前缀进不了 node 进程 -> 支持 argv 传 JWT 或读 jiguang_token.txt
const TOKEN = (() => {
  const i = process.argv.findIndex(a => typeof a === 'string' && a.startsWith('eyJ') && a.split('.').length === 3);
  if (i >= 0) { const t = process.argv[i]; process.argv.splice(i, 1); return t; }
  if (process.env.JIGUANG_TOKEN) return process.env.JIGUANG_TOKEN;
  try { return fs.readFileSync(path.join(process.cwd(), 'jiguang_token.txt'), 'utf8').trim(); } catch (e) { return ''; }
})();
// 2026-07-20 起 API 已从 http://ji-guang.top 迁移到独立域名 https://api.ji-guang.top
// 学科列表为公开接口（无需鉴权）；章节/题目接口才需有效的 JWT。
const BASE = 'https://api.ji-guang.top/api/v1';

function req(p, retry = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const u = new URL(BASE + p);
      const opt = {
        hostname: u.hostname, port: 443,
        path: u.pathname + u.search, method: 'GET',
        headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' }
      };
      const r = https.request(opt, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 429 || res.statusCode >= 500) {
            if (n > 0) { console.log(`   [限流${res.statusCode}] 退避8s...`); setTimeout(() => attempt(n - 1), 8000); return; }
            reject(new Error('限流重试耗尽: ' + res.statusCode)); return;
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('parse失败: ' + data.slice(0, 200))); }
        });
      });
      r.on('error', e => { if (n > 0) setTimeout(() => attempt(n - 1), 8000); else reject(e); });
      r.end();
    };
    attempt(retry);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) 扫描本地所有 极光_*.json
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(fp, acc);
    } else if (/^极光_.*\.json$/.test(e.name) && !/\.bak_/.test(e.name)) acc.push(fp);  // 排除修复备份, 否则会爬进 .bak_ 旧文件
  }
  return acc;
}
const files = walk(process.cwd(), []);
const local = new Map(); // subjectId -> {file, name, count}
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (d.subjectId) {
      const cnt = d.chapters ? d.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : (c.count || 0)), 0) : 0;
      local.set(d.subjectId, { file: f, name: d.subject, count: cnt });
    }
  } catch (e) {}
}

// 2) 翻页发现全站学科
async function discover() {
  const out = [];
  let skip = 0, limit = 50;
  while (true) {
    const d = (await req(`/user/subjects/?skip=${skip}&limit=${limit}`)).data;
    const items = d.items || d;
    out.push(...items);
    if (!d.has_more || !items.length || out.length > 500) break;   // 防空转死循环
    skip += limit;
    await sleep(200);
  }
  return out;
}

const all = await discover();
const apiMap = new Map();
for (const s of all) apiMap.set(s.id, s);

console.log(`\n本地已爬学科: ${local.size} | 全站学科: ${all.length}\n`);
console.log('=== 本地学科更新情况（以全站公开 total_questions 为准） ===');
const updated = [], notfound = [], same = [];
for (const [sid, info] of local) {
  const api = apiMap.get(sid);
  if (!api) { notfound.push(info); console.log(`[消失]   ${info.name} (${info.count}题) — 全站已无此 subjectId`); continue; }
  // 公开列表接口即可拿到当前 total_questions，无需鉴权
  const cur = api.total_questions || 0;
  const delta = cur - info.count;
  if (delta > 0) { updated.push({ sid, name: info.name, file: info.file, local: info.count, cur, delta }); console.log(`[更新+]  ${info.name}: 本地 ${info.count} -> 当前 ${cur} (新增约 ${delta})`); }
  else if (delta < 0) { console.log(`[减少-]  ${info.name}: 本地 ${info.count} -> 当前 ${cur} (少 ${-delta}, 可能题目下架)`); }
  else { same.push(info.name); console.log(`[无变化] ${info.name}: ${cur}`); }
}

const localIds = new Set(local.keys());
const news = all.filter(s => !localIds.has(s.id) && (s.total_questions || 0) > 0 && s.has_access !== false);
console.log('\n=== 全站新学科（本地未爬） ===');
for (const s of news) console.log(`[新]     ${s.name} (${s.total_questions}题) id=${s.id}`);

console.log('\n=== 汇总 ===');
console.log(`需更新: ${updated.length} | 无变化: ${same.length} | 消失: ${notfound.length} | 新学科: ${news.length}`);
fs.writeFileSync('jiguang_update_report.json', JSON.stringify({
  updated: updated.map(u => ({ name: u.name, sid: u.sid, file: u.file, local: u.local, cur: u.cur, delta: u.delta })),
  notfound: notfound.map(n => n.name),
  news: news.map(s => ({ name: s.name, sid: s.id, total: s.total_questions }))
}, null, 2), 'utf8');
console.log('报告已写入 jiguang_update_report.json');
