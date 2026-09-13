// 极光题库 - 外科学自动循环爬取器 (2026-08-11)
// 慢速稳妥连续爬: 每轮 BUDGET=40 请求预算, GAP=3000ms, 跑完自动下一轮, 直到 1150 题或 token 失效
// 用法: JIGUANG_TOKEN=有效JWT node jiguang_waike_loop.mjs
import { execSync } from 'child_process';
import fs from 'fs';

const TOKEN = process.env.JIGUANG_TOKEN;
if (!TOKEN) { console.error('需要 JIGUANG_TOKEN'); process.exit(1); }
const GOAL = 1150;
const FILE = '../题源数据/大四/外科学（test）/1.题库/极光_外科学（test）.json';
const BUDGET = process.env.BUDGET || '40';
const GAP = process.env.GAP || '3000';
const LOG = 'jiguang_waike_loop.log';
const CRAWLLOG = 'jiguang_waike_crawl.log';

const log = m => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };

function currentCount() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return d.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0);
  } catch (e) { return -1; }
}

async function main() {
  log(`外科学循环启动: 目标${GOAL}, 每轮BUDGET=${BUDGET} GAP=${GAP}ms, 当前${currentCount()}`);
  let round = 0, failStreak = 0;
  while (true) {
    round++;
    const n = currentCount();
    if (n >= GOAL) { log(`✅ 外科学完成! ${n}/${GOAL}`); break; }
    log(`第${round}轮开始 (当前${n}/${GOAL})...`);
    let out = '';
    try {
      out = execSync(`node jiguang_new_subjects_crawl.mjs "外科学（test）"`, { env: { ...process.env, BUDGET, GAP }, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      fs.appendFileSync(CRAWLLOG, `\n[第${round}轮 ${new Date().toLocaleString('zh-CN')}]\n` + out);
    } catch (e) {
      out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '') + '\n[ERR] ' + e.message;
      fs.appendFileSync(CRAWLLOG, `\n[第${round}轮异常]\n` + out);
    }
    const n2 = currentCount();
    const tail = out.split('\n').slice(-3).join(' | ');
    log(`第${round}轮结束: ${n}→${n2} (+${n2 - n})`);
    // 风控判断: 401=token废, 大量429=限流
    if (out.includes('401') || (out.match(/429/g) || []).length >= 6) {
      failStreak++;
      log(`⚠️ 风控信号(401/大量429), 等待5min (连续${failStreak}次)`);
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      if (failStreak >= 3) { log('🛑 连续3次风控, 退出等待用户'); break; }
    } else {
      failStreak = 0;
      await new Promise(r => setTimeout(r, 30 * 1000)); // 轮间短歇
    }
  }
  log('循环结束');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
