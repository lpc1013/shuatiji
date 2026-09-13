// 修复「题干混入选项」类数据错误 (2026-08-31)
// 现象: 题干末尾被拼上 " E选项内容", 且该字母不在 options 里 -> 作答时选项缺失
// 成因: 题库导入拼接 bug
// 无法走 API 重取: 涉事学科多为 VIP (HTTP_403 SUBJECT_ACCESS_REQUIRED), 只能本地重建
// 用法: node jiguang_fix_stem_leak.mjs          # 干跑, 只打印
//       node jiguang_fix_stem_leak.mjs apply    # 实际写盘 (自动 .bak_YYYYMMDD 备份)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('apply');
const ROOTS = ['大一', '大二', '大三', '大四', '水平测试'];
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

function walk(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/^极光_.*\.json$/.test(e.name) && !/\.bak_/.test(e.name)) acc.push(p);
  }
  return acc;
}

// 定位题干尾部被吞掉的选项: 形如 " Xxxx", X ∈ A-E 且 X 不在 options
// 防伪规则: 字母后紧跟小写字母视为代码标识符 (如 python 题干里 "Not Equal" 的 E), 不算泄漏
function findLeak(content, optKeys) {
  const c = content;
  const cands = [];
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch !== ' ' && ch !== '\u3000') continue;
    const L = c[i + 1];
    if (!L || !LETTERS.includes(L)) continue;
    const next = c[i + 2];
    if (!next) continue;
    if (/[a-z]/.test(next)) continue;          // 代码标识符, 排除
    if (optKeys.includes(L)) continue;          // 该字母已有选项, 排除
    cands.push({ i, L });
  }
  if (!cands.length) return null;
  // 取尾部一段: 字母严格升序, 且末尾一直延伸到 content 结尾
  const last = cands[cands.length - 1];
  const run = [last];
  for (let k = cands.length - 2; k >= 0; k--) {
    const prev = cands[k];
    if (LETTERS.indexOf(prev.L) >= LETTERS.indexOf(run[0].L)) break;   // 必须严格升序
    run.unshift(prev);
  }
  // 每个候选字母都必须缺失于 options, 且选项文本非空
  for (let k = 0; k < run.length; k++) {
    const start = run[k].i + 2;
    const end = (k + 1 < run.length) ? run[k + 1].i : c.length;
    const text = c.slice(start, end);
    if (!text.trim()) return null;
  }
  const stem = c.slice(0, run[0].i).replace(/\s+$/, '');
  if (stem.length < 5) return null;
  const opts = run.map((r, k) => {
    const start = r.i + 2;
    const end = (k + 1 < run.length) ? run[k + 1].i : c.length;
    return { L: r.L, text: c.slice(start, end) };
  });
  return { stem, opts };
}

const files = ROOTS.flatMap(r => walk(path.join(HERE, '..', '题源数据', r)));
let totalFixed = 0, totalQ = 0;
const report = [];

for (const f of files) {
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
  const chapters = Array.isArray(d.chapters) ? d.chapters : [];
  let changed = 0;
  const details = [];
  for (const ch of chapters) {
    for (const q of (ch.questions || [])) {
      const content = (q.content ?? '').toString();
      if (!content) continue;
      const opts = q.options || {};
      const keys = Object.keys(opts).filter(k => String(opts[k] ?? '').trim() !== '');
      const leak = findLeak(content, keys);
      if (!leak) continue;
      totalQ++;
      details.push({
        chapter: ch.name, id: q.id,
        before_tail: content.slice(-45),
        recovered: leak.opts.map(o => `${o.L}=${o.text}`).join(' | '),
        stem_tail_after: leak.stem.slice(-25)
      });
      q.content = leak.stem;
      for (const o of leak.opts) opts[o.L] = o.text;
      q.options = opts;
      changed++;
    }
  }
  if (changed) {
    totalFixed += changed;
    const rel = path.relative(HERE, f).replace(/\\/g, '/');
    report.push({ file: rel, fixed: changed, details });
    if (APPLY) {
      const bak = f.replace(/\.json$/, `.bak_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`);
      if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
      fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');
      console.log(`✅ ${rel} 修复 ${changed} 题 (备份 ${path.basename(bak)})`);
    } else {
      console.log(`[干跑] ${rel} 将修复 ${changed} 题`);
    }
    for (const x of details) {
      console.log(`   · ${x.chapter} | 恢复: ${x.recovered}`);
      console.log(`     修复前尾部: ...${x.before_tail}`);
      console.log(`     修复后题干尾部: ...${x.stem_tail_after}`);
    }
  }
}

console.log(`\n${APPLY ? '已修复' : '将修复'} ${totalFixed} 题 / ${report.length} 个文件`);
if (!APPLY) console.log('确认无误后加 apply 参数执行写盘');
