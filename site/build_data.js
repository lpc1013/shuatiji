// 重新生成 data.js（爬虫跑完后执行）：node build_data.js
// 读取上层目录的两个题库 JSON，归一化为 site/data/data.js
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function normQ(q) {
  const opts = q.options || {};
  let correct = q.correct_answer;
  if (Array.isArray(correct)) correct = correct.join('');
  correct = correct || '';
  const multi = typeof correct === 'string' && correct.length > 1;
  return {
    id: q.id, chapterId: q.chapter_id || null,
    type: q.display_type || (multi ? '多选' : 'A1'),
    content: q.content || q.stem || '',
    options: opts, correct, multi,
    difficulty: q.difficulty,
    images: q.images || [],
    explanation: (q.ai_explanation || q.explanation || '').trim(),
    tags: q.tags || []
  };
}
function normBio(d) {
  return {
    id: d.subjectId || 'bio', name: d.subject || '生物化学',
    chapters: (d.chapters || []).map((c, i) => ({
      id: c.id, name: c.name || ('第' + (i + 1) + '章'),
      questions: (c.questions || []).map(normQ).filter(q => q.content)
    }))
  };
}
function normArray(arr, name) {
  const map = {};
  for (const q of arr) { const k = q.chapter_id || 'none'; (map[k] = map[k] || []).push(q); }
  const chapters = Object.keys(map).map((k, i) => ({
    id: k, name: (k === 'none' ? '未分类' : ('第' + (i + 1) + '章')),
    questions: map[k].map(normQ).filter(q => q.content)
  }));
  return { id: 'anatomy', name, chapters };
}
// 下学期要学的三个题库：生物化学、生理学、医学免疫学（系统解剖学等暂不纳入）
// 源 JSON 实际位于各科目子目录的 1.题库/ 下（与爬虫输出一致），直接指向真实路径
const bio = normBio(JSON.parse(fs.readFileSync(path.resolve(ROOT, '大二/生化/1.题库/极光_生化.json'), 'utf8')));
const physio = normBio(JSON.parse(fs.readFileSync(path.resolve(ROOT, '大二/生理/1.题库/极光_生理.json'), 'utf8')));
physio.id = 'physiology'; physio.name = '生理学';
const immuno = normBio(JSON.parse(fs.readFileSync(path.resolve(ROOT, '大二/免疫/1.题库/极光_免疫.json'), 'utf8')));
immuno.id = 'immunology'; immuno.name = '医学免疫学';
const out = { bio, physiology: physio, immunology: immuno };
fs.writeFileSync(path.join(__dirname, 'data', 'data.js'), 'window.QBANKS = ' + JSON.stringify(out) + ';\n', 'utf8');
console.log('已生成 data.js | 生化', bio.chapters.length, '章', bio.chapters.reduce((a, c) => a + c.questions.length, 0),
  '题 | 生理学', physio.chapters.length, '章', physio.chapters.reduce((a, c) => a + c.questions.length, 0),
  '题 | 医学免疫学', immuno.chapters.length, '章', immuno.chapters.reduce((a, c) => a + c.questions.length, 0), '题');

// 自动给 index.html 里 data.js 引用打当天版本号，避免浏览器/CDN 缓存旧题库（纯前端更新静态资源的通用坑）
const idxPath = path.join(__dirname, 'index.html');
if (fs.existsSync(idxPath)) {
  const ver = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const html = fs.readFileSync(idxPath, 'utf8');
  const next = html.replace(/data\/data\.js(\?v=[^"]*)?/, 'data/data.js?v=' + ver);
  if (next !== html) { fs.writeFileSync(idxPath, next, 'utf8'); console.log('已更新 index.html 引用版本 ?v=' + ver); }
  else console.log('index.html 引用已带版本 ?v=' + ver);
}
