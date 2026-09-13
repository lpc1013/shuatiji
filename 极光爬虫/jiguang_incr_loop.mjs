// 极光题库 - 增量学科循环爬取器 (2026-08-11)
// 逐学科循环爬增量(每轮预算独立), 直到该学科达标, 再换下一个
// 用法: JIGUANG_TOKEN=有效JWT BUDGET=60 GAP=2500 node jiguang_incr_loop.mjs
import { execSync } from 'child_process';
import fs from 'fs';

const TOKEN = process.env.JIGUANG_TOKEN;
if (!TOKEN) { console.error('需要 JIGUANG_TOKEN'); process.exit(1); }
const BUDGET = process.env.BUDGET || '60';
const GAP = process.env.GAP || '2500';
const LOG = 'jiguang_incr_loop.log';
const CRAWLLOG = 'jiguang_incr_crawl.log';

// 08-11 check_updates 检测出的增量学科 (goal = 全站当前 total)
const TARGETS = [
  { name: '影像',               goal: 493,  file: '../题源数据/大三/影像/1.题库/极光_影像.json' },
  { name: '病理学',             goal: 1595, file: '../题源数据/大二/病理/1.题库/极光_病理.json' },
  { name: '儿童医院社区实习',    goal: 262,  file: '../题源数据/大四/儿童医院社区实习/1.题库/极光_儿童医院社区实习.json' },
  { name: '耳鼻咽喉头颈外科学',  goal: 1101, file: '../题源数据/大四/耳鼻咽喉头颈外科学/1.题库/极光_耳鼻咽喉头颈外科学.json' },
  { name: '内科学（test）',     goal: 819,  file: '../题源数据/大四/内科学（test）/1.题库/极光_内科学（test）.json' },
];

const log = m => { const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };

function count(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d.chapters.reduce((a, c) => a + (c.questions ? c.questions.length : 0), 0);
  } catch (e) { return -1; }
}

async function main() {
  log(`增量循环启动: ${TARGETS.length} 学科, BUDGET=${BUDGET} GAP=${GAP}ms`);
  for (const t of TARGETS) {
    let cur = count(t.file);
    log(`==> [${t.name}] 当前${cur} 目标${t.goal}`);
    if (cur >= t.goal) { log(`   已达标, 跳过`); continue; }
    let round = 0, failStreak = 0;
    while (count(t.file) < t.goal) {
      round++;
      cur = count(t.file);
      let out = '';
      try {
        out = execSync(`node jiguang_new_subjects_crawl.mjs "${t.name}"`, { env: { ...process.env, BUDGET, GAP }, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        fs.appendFileSync(CRAWLLOG, `\n[${t.name} 第${round}轮 ${new Date().toLocaleString('zh-CN')}]\n` + out);
      } catch (e) {
        out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '') + '\n[ERR] ' + e.message;
        fs.appendFileSync(CRAWLLOG, `\n[${t.name} 第${round}轮异常]\n` + out);
      }
      const n2 = count(t.file);
      log(`  [${t.name}] 第${round}轮: ${cur}→${n2} (+${n2 - cur})`);
      // 风控: 401=token废, 大量429=限流
      if (out.includes('401 鉴权失败') || (out.match(/429/g) || []).length >= 6) {
        failStreak++;
        log(`  ⚠️ 风控信号, 等5min (连续${failStreak})`);
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
        if (failStreak >= 3) { log(`  🛑 连续3次风控, 中止[${t.name}]等待用户`); process.exit(1); }
      } else {
        failStreak = 0;
        await new Promise(r => setTimeout(r, 20 * 1000)); // 轮间短歇
      }
    }
    log(`✅ [${t.name}] 完成: ${count(t.file)}/${t.goal}`);
  }
  log('=== 全部增量学科完成 ===');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
