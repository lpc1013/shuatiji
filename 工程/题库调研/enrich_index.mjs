// 建索引：
//   1) 极光原始题统计   → index_jiguang_stats.json   { id: {d,ta,tc,tf,cm,nt,img} }
//   2) iyixue 原始元数据 → index_iyixue_meta.json     { id: {year,qs,sys,d,ci} }
// 只读，不改任何源文件。
import fs from 'fs';
import path from 'path';

const WS = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学';
const SKIP_DIR = new Set(['node_modules', '.git', '题库调研', 'iyixue_top', '爬虫与构建产物', '.workbuddy']);

// ---------- 1) 极光 ----------
const jg = {};
const jgFiles = [];
(function walk(d) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p); }
    else if (/^极光_.+\.json$/.test(e.name)) jgFiles.push(p);
  }
})(WS);

let jgN = 0;
for (const f of jgFiles) {
  let o; try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  for (const c of (o.chapters || [])) for (const q of (c.questions || [])) {
    if (!q || !q.id || jg[q.id]) continue;
    jg[q.id] = {
      d: q.difficulty ?? null,
      ta: q.total_answer_count ?? 0,
      tc: q.total_correct_count ?? 0,
      tf: q.total_favorite_count ?? 0,
      cm: q.comment_count ?? 0,
      nt: q.note_count ?? 0,
      img: (Array.isArray(q.images) && q.images.length) ? q.images.length : 0,
      cid: q.chapter_id ?? null,
      ch: (c.name || '') ,
    };
    jgN++;
  }
}
fs.writeFileSync(path.join(WS, '工程', '题库调研', 'index_jiguang_stats.json'), JSON.stringify(jg), 'utf8');
console.log(`极光索引：${jgFiles.length} 文件 → ${jgN} 条`);

// 分布统计
const dd = {}, tt = [];
for (const id in jg) { dd[jg[id].d] = (dd[jg[id].d] || 0) + 1; tt.push(jg[id].ta); }
tt.sort((a, b) => a - b);
const pct = p => tt.length ? tt[Math.min(tt.length - 1, Math.floor(tt.length * p))] : 0;
console.log('  difficulty 分布:', JSON.stringify(dd));
console.log('  total_answer_count 中位数:', pct(0.5), ' P90:', pct(0.9), ' 最大:', tt[tt.length - 1] || 0);
console.log('  非零答题数:', tt.filter(x => x > 0).length, '/', tt.length);

// ---------- 2) iyixue ----------
const yx = {};
let yxFiles = 0, yxN = 0;
for (const bank of ['school', 'kaoyan']) {
  const base = path.join(WS, '工程', 'iyixue_top', bank);
  if (!fs.existsSync(base)) continue;
  for (const sub of fs.readdirSync(base)) {
    const sp = path.join(base, sub);
    if (!fs.statSync(sp).isDirectory()) continue;
    for (const f of fs.readdirSync(sp)) {
      if (!f.endsWith('.json')) continue;
      let o; try { o = JSON.parse(fs.readFileSync(path.join(sp, f), 'utf8')); } catch { continue; }
      yxFiles++;
      const arr = Array.isArray(o) ? o : (o.data || o.questions || o.rows || []);
      for (const q of arr) {
        if (!q || !q.id || yx[q.id]) continue;
        yx[q.id] = {
          year: q.year ?? null,
          qs: q.questionSource ?? null,
          sys: q.system ?? null,
          d: q.difficulty ?? null,
          ci: q.caseInfo ? 1 : 0,
        };
        yxN++;
      }
    }
  }
}
fs.writeFileSync(path.join(WS, '工程', '题库调研', 'index_iyixue_meta.json'), JSON.stringify(yx), 'utf8');
console.log(`iyixue 索引：${yxFiles} 文件 → ${yxN} 条`);
const yy = {}, qq = {};
for (const id in yx) { const v = yx[id]; if (v.year) yy[v.year] = (yy[v.year] || 0) + 1; if (v.d) qq[v.d] = (qq[v.d] || 0) + 1; }
console.log('  year 分布 top:', JSON.stringify(Object.entries(yy).sort((a, b) => b[1] - a[1]).slice(0, 10)));
console.log('  difficulty 分布:', JSON.stringify(qq));
