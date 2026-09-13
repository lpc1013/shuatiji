// 极光题库 - 快速冲刺循环器 (2026-08-11)
// 用户决策: 封禁前最大化吞吐, 循环"探测→快速爬→限流→等→再探"
// 每 5min 探测, 解封即跑快速爬虫(高并发), 爬完/被封后等 5min 再探
// 用法: JIGUANG_TOKEN=有效JWT node jiguang_rapid_loop.mjs
import { execSync } from 'child_process';
import https from 'https';
import fs from 'fs';

const TOKEN = process.env.JIGUANG_TOKEN;
if (!TOKEN) { console.error('需要 JIGUANG_TOKEN'); process.exit(1); }
const WAIT_MIN = 5;              // 限流等待/爬后间隔
const TEST_SID = 'e1e0517c-2371-4d39-84b7-816deda1d049';  // 外科学(剩余最多, 探测真实)
const LOG = 'jiguang_rapid_loop.log';

function probe() {
  return new Promise((resolve) => {
    const u = new URL('https://api.ji-guang.top/api/v1/user/subjects/' + TEST_SID);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200 && d.includes('"success":true'), code: res.statusCode }));
    });
    r.setTimeout(15000, () => { r.destroy(); resolve({ ok: false, code: 'timeout' }); });
    r.on('error', () => resolve({ ok: false, code: 'err' }));
    r.end();
  });
}

const log = m => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  log(`快速冲刺循环启动: 探测${TEST_SID.slice(0, 8)}, 每轮间隔${WAIT_MIN}min`);
  let round = 0;
  while (true) {
    round++;
    const r = await probe();
    if (r.ok) {
      log(`第${round}轮: 解封(HTTP 200)! 启动快速爬取(并发5, 无节流)...`);
      try {
        const out = execSync(`node jiguang_rapid_crawl.mjs`, { env: process.env, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        fs.appendFileSync('jiguang_rapid_2026-08-11.log', '\n[循环' + round + '结束]\n' + out);
        log('本轮爬取正常结束');
      } catch (e) {
        const tail = (e.stdout ? e.stdout.toString().slice(-300) : '') || e.message.slice(0, 150);
        fs.appendFileSync('jiguang_rapid_2026-08-11.log', '\n[循环' + round + '异常]\n' + (e.stdout ? e.stdout.toString() : '') + '\n' + e.message + '\n');
        log('本轮被封/异常: ' + tail.replace(/\n/g, ' | '));
      }
      log(`等待 ${WAIT_MIN}min 后继续`);
    } else {
      log(`第${round}轮: HTTP ${r.code} 限流中, ${WAIT_MIN}min后重试`);
    }
    await sleep(WAIT_MIN * 60 * 1000);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
