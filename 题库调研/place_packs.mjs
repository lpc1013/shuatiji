// 把 packs/<学期>/{极光,扩展,explain}/<学科>.json 落位到
//   <学期>/<科短名>/3.整合题库/{极光题_<短名>.json, 扩展题_<短名>.json, 解析_<短名>.json}
// raw 的 1.题库/ 一律不动。
// 用法：node place_packs.mjs            → dry-run（只打印）
//       node place_packs.mjs --apply   → 实际拷贝
import fs from 'fs';
import path from 'path';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const PACKS = path.join(WS, '题库调研', 'packs');
const APPLY = process.argv.includes('--apply');

// packs 学科名 → 用户学期文件夹里的短名
const SUB_SHORT = {
  大一: {
    'python': 'python', '军事理论': '军事理论', '医用物理学': '医用物理学',
    '思想道德与法治': '思想道德与法治', '系统解剖学': '系统解剖学',
    '组织学与胚胎学': '组胚', '医学细胞生物学': '细胞生物学',
  },
  大二: {
    '医学伦理学': '伦理', '医学免疫学': '免疫', '医学微生物学': '微生物',
    '生物化学': '生化', '生理学': '生理', '病理学': '病理',
    '病理生理学': '病理生理', '医学遗传学': '遗传', '马克思主义原理': '马原',
  },
  大三: {
    '诊断学': '临床诊断', '医学统计学': '医学统计学', '卫生学': '卫生学',
    '外基': '外基', '实验诊断': '实验诊断', '医学影像学': '影像',
    '核医学': '核医学', '近代史': '近代史',
  },
  大四: {
    '传染病学': '传染病（test）', '儿科学': '儿科学', '内科学': '内科学',
    '医患沟通': '医患沟通', '外科学': '外科学', '小儿外科学': '小儿外科学',
    '急诊与灾难医学': '急诊与灾难医学', '皮肤性病学': '皮肤性病学',
    '眼科学': '眼科学', '神经病学': '神经病学', '精神病学': '精神病学',
    '耳鼻咽喉头颈外科学': '耳鼻咽喉头颈外科学',
  },
  水平测试: {}, // 同名直通
};

const SEMS = ['大一', '大二', '大三', '大四', '水平测试'];
const lines = [];
const plan = [];
const problems = [];

function cnt(arr) { return Array.isArray(arr) ? arr.length : 0; }

for (const sem of SEMS) {
  const base = path.join(PACKS, sem);
  if (!fs.existsSync(base)) continue;
  const shortMap = SUB_SHORT[sem] || {};
  const packSubs = new Set();
  for (const grp of ['极光', '扩展']) {
    const gp = path.join(base, grp);
    if (fs.existsSync(gp)) for (const f of fs.readdirSync(gp)) packSubs.add(f.replace(/\.json$/, ''));
  }
  // explain 可能含 packs 里没有极光/扩展的学科，忽略其独有项
  lines.push(`\n=== ${sem} ===`);
  for (const sub of [...packSubs].sort()) {
    const short = shortMap[sub] || sub;
    const dir = path.join(WS, sem, short);
    const exists = fs.existsSync(dir);
    const jgP = path.join(base, '极光', sub + '.json');
    const exP = path.join(base, '扩展', sub + '.json');
    const epP = path.join(base, 'explain', sub + '.json');
    let jgN = 0, exN = 0, epN = 0;
    if (fs.existsSync(jgP)) jgN = cnt(JSON.parse(fs.readFileSync(jgP, 'utf8')));
    if (fs.existsSync(exP)) exN = cnt(JSON.parse(fs.readFileSync(exP, 'utf8')));
    if (fs.existsSync(epP)) { const o = JSON.parse(fs.readFileSync(epP, 'utf8')); epN = Object.keys(o).length; }
    plan.push({ sem, sub, short, dir, exists, jgP: fs.existsSync(jgP) ? jgP : null, exP: fs.existsSync(exP) ? exP : null, epP: fs.existsSync(epP) ? epP : null, jgN, exN, epN });
    if (!exists) problems.push(`${sem}/${short} 目录不存在（packs 学科「${sub}」无处安放）`);
    lines.push(`  ${sub.padEnd(16)} → ${sem}/${short.padEnd(14)} 极光${String(jgN).padStart(6)}  扩展${String(exN).padStart(6)}  解析${String(epN).padStart(6)}  ${exists ? '' : '  ⚠目录不存在'}`);
  }
  // 反向：用户有目录但 packs 无
  const userDirs = fs.existsSync(path.join(WS, sem)) ? fs.readdirSync(path.join(WS, sem)).filter(d => fs.statSync(path.join(WS, sem, d)).isDirectory()) : [];
  const mappedShorts = new Set([...packSubs].map(s => shortMap[s] || s));
  const orphan = userDirs.filter(d => !mappedShorts.has(d));
  if (orphan.length) lines.push(`  ⚠ 用户目录无 packs 对应：${orphan.join(', ')}`);
}

lines.push('\n=== 汇总 ===');
lines.push(`计划落位 ${plan.length} 个学科目录，问题 ${problems.length} 条`);
plan.filter(p => !p.exists).forEach(p => lines.push(`  ⚠ ${p.sem}/${p.short}`));

console.log(lines.join('\n'));

if (APPLY) {
  const out = [];
  let copied = 0;
  for (const p of plan) {
    const tk = path.join(p.dir, '3.整合题库');
    fs.mkdirSync(tk, { recursive: true });
    if (!fs.existsSync(tk)) { out.push('mkdir FAILED ' + tk); continue; }
    const jobs = [];
    if (p.jgP) jobs.push([p.jgP, path.join(tk, `极光题_${p.short}.json`)]);
    if (p.exP) jobs.push([p.exP, path.join(tk, `扩展题_${p.short}.json`)]);
    if (p.epP) jobs.push([p.epP, path.join(tk, `解析_${p.short}.json`)]);
    for (const [src, dst] of jobs) {
      fs.copyFileSync(src, dst);
      const ok = fs.existsSync(dst) && fs.statSync(dst).size > 0;
      copied++;
      out.push((ok ? 'OK   ' : 'FAIL ') + dst.replace(WS + '/', '') + '  ' + (fs.statSync(dst).size / 1048576).toFixed(2) + 'MB');
      if (!ok) problems.push('copy failed ' + dst);
    }
  }
  console.log('\n=== 拷贝结果 ===');
  console.log(out.join('\n'));
  console.log(`\n共拷贝 ${copied} 个文件`);
  console.log('=== 独立枚举验证 ===');
  for (const sem of SEMS) {
    const root = path.join(WS, sem);
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const tk = path.join(root, d, '3.整合题库');
      if (fs.existsSync(tk)) {
        const fs2 = fs.readdirSync(tk);
        const sizes = fs2.map(f => (fs.statSync(path.join(tk, f)).size / 1048576).toFixed(2) + 'MB');
        console.log(`  ${sem}/${d}: ${fs2.length} 文件  [${sizes.join(' ')}]`);
      }
    }
  }
}
