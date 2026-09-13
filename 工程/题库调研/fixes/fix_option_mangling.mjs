// fix_option_mangling.mjs
// 修复极光题库 B1 型配伍题 / 个别 A1 题「备选选项被并入题干、并从 options 缺失」的数据损坏。
//
// 用法（在 workspace 根目录运行）：
//   node fix_option_mangling.mjs            # 默认 dry-run，只打印拟改动，不写文件
//   node fix_option_mangling.mjs --apply    # 真正写回三个 极光_*.json
//
// 策略：
//   - 免疫学 / 生理学：自动修复（从题干把缺失字母的选项文本提回 options，并清掉题干冗余）。
//   - 生物化学：仅检测次级损坏（串题/答案片段），不自动改，输出清单人工复核。
//   - 只改 q.content / q.options，不动 id、顺序、其它字段 → localStorage 进度按 id 关联，全部保留。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const LETTERS = 'ABCDEFGH';

const FILES = [
  { key: 'immuno', label: '医学免疫学', file: '../../题源数据/大二/免疫/1.题库/极光_免疫.json' },
  { key: 'phys',   label: '生理学',     file: '../../题源数据/大二/生理/1.题库/极光_生理.json' },
  { key: 'bio',    label: '生物化学',   file: '../../题源数据/大二/生化/1.题库/极光_生化.json' },
];

// 从题干为缺失字母 L 提取选项文本，并把该段从题干删除。返回 { content, report }
// 题干里备选标记的三种形态：① "L. 文本" 带点  ② "L文本" 无点贴附  ③ 完全无字母前缀(尾随整段)
function recover(content, options, missingLetters) {
  const report = [];
  let nc = content;
  for (const L of missingLetters) {
    const other = LETTERS.replace(L, '');
    let text = null, matched = null;
    // ① 带点前缀
    let re = new RegExp('(^|\\s)' + L + '\\.\\s*([\\s\\S]*?)(?=\\s+[' + other + ']\\.\\s|$)', 'g');
    let m = re.exec(nc);
    if (m) { text = m[2].trim(); matched = m[0]; }
    else {
      // ② 无点贴附前缀（L 后直接跟非空格非点字符）
      re = new RegExp('(^|\\s)' + L + '(?![.\\s])([^\\s][\\s\\S]*?)(?=\\s+[' + other + ']\\.\\s|$)', 'g');
      m = re.exec(nc);
      if (m) { text = m[2].trim(); matched = m[0]; }
      else {
        // ③ 完全无前缀：取最后一个空格之后的整段
        const idx = nc.lastIndexOf(' ');
        if (idx > 0) { text = nc.slice(idx + 1).trim(); matched = nc.slice(idx); }
      }
    }
    if (!text) { report.push({ letter: L, ok: false }); continue; }
    options[L] = text;
    if (matched) nc = nc.replace(matched, '');
    nc = nc.replace(/\s+$/, '');
    report.push({ letter: L, text, ok: true });
  }
  return { content: nc.trim(), report };
}

function scan() {
  const fixes = [], bioDetect = [];
  for (const sub of FILES) {
    const p = path.resolve(ROOT, sub.file);
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    let changed = 0;
    for (const c of d.chapters) {
      c.questions.forEach((q, i) => {
        const optKeys = new Set(Object.keys(q.options || {}));
        const ca = q.correct_answer || '';
        const caLetters = ca.match(/[A-H]/g) || [];
        const missingFromCa = caLetters.filter(l => !optKeys.has(l));
        const content = q.content || '';
        const embedded = [];
        for (const L of LETTERS.split('')) {
          if (optKeys.has(L)) continue;
          if (new RegExp('(^|\\s)' + L + '\\.\\s').test(content)) embedded.push(L);
        }
        const missing = [...new Set([...missingFromCa, ...embedded])].sort();

        if (sub.key === 'bio') {
          // 生化：检测「options 含 F-H 且疑似串题/答案片段」的次级损坏，不自动改
          const beyond = [...optKeys].filter(k => ['F', 'G', 'H', 'I', 'J'].includes(k));
          if (beyond.length) {
            const hasNewline = content.includes('\n');
            const hasNum = /^\s*\d+[.、]/.test(content.split('\n')[1] || '');
            const fgVals = beyond.map(k => q.options[k]);
            const shortFrag = fgVals.some(v => !v || v.length <= 3);
            const embedInContent = /\b[F-J]\.\s/.test(content);
            if (hasNewline || hasNum || shortFrag || embedInContent) {
              bioDetect.push({ sub: sub.label, ch: c.sort_order + ' ' + c.name, q: i + 1, id: q.id.slice(0, 8), beyond, reasons: { hasNewline, hasNum, shortFrag, embedInContent }, fg: fgVals, contentSnippet: content.replace(/\n/g, ' | ').slice(0, 120) });
            }
          }
          return;
        }

        if (!missing.length) return;
        const before = content;
        const { content: after, report } = recover(content, q.options, missing);
        const recovered = report.filter(r => r.ok).map(r => r.letter);
        const failed = report.filter(r => !r.ok).map(r => r.letter);
        fixes.push({ sub: sub.label, ch: c.sort_order + ' ' + c.name, q: i + 1, id: q.id.slice(0, 8), ca, missing, recovered, failed, contentBefore: before, contentAfter: after, optionsAfter: q.options });
        changed++;
      });
    }
    sub._data = d; sub._changed = changed;
  }
  return { fixes, bioDetect };
}

const { fixes, bioDetect } = scan();

console.log('============ 拟自动修复（免疫学 + 生理学）============');
for (const f of fixes) {
  console.log(`\n● [${f.sub}] ${f.ch} 第${f.q}题 (id=${f.id})  ca=${JSON.stringify(f.ca)}`);
  console.log(`  缺失字母=${f.missing.join(',')}  成功恢复=${f.recovered.join(',') || '-'}  失败=${f.failed.join(',') || '-'}`);
  console.log(`  题干前: ${f.contentBefore.replace(/\n/g, ' ')}`);
  console.log(`  题干后: ${f.contentAfter.replace(/\n/g, ' ')}`);
  console.log(`  options: ${JSON.stringify(f.optionsAfter)}`);
}
console.log(`\n自动修复总计: ${fixes.length} 题（免疫 7 + 生理 5）`);

console.log('\n============ 生物化学：仅检测、不自动改（次级损坏，人工复核）============');
console.log(`待人工复核: ${bioDetect.length} 题`);
bioDetect.forEach(b => console.log(`  [${b.sub}] ${b.ch} 第${b.q}题 id=${b.id} 含${b.beyond.join('')} 标志=${JSON.stringify(b.reasons)} | ${b.contentSnippet}`));

if (APPLY) {
  for (const sub of FILES) {
    if (sub.key === 'bio') continue;
    if (!sub._changed) continue;
    const p = path.resolve(ROOT, sub.file);
    fs.writeFileSync(p, JSON.stringify(sub._data), 'utf8');
    console.log(`\n[已写回] ${sub.file}（改动 ${sub._changed} 题）`);
  }
} else {
  console.log('\n>>> 当前为 dry-run，未写回任何文件。确认无误后加 --apply 执行。');
}
