/* 刷题记 · 个人学习站  —  纯前端，无后端，状态存 localStorage */
'use strict';
const SB = window.QBANKS || {};
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 状态 ---------- */
const LS_KEY = 'quiz_v1';
function defaultState() {
  return { global: { xp: 0, badges: [], checkin: [], settings: { dark: false, font: 'm' } }, subjects: {}, sessions: {} };
}
let S = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.global) {
      if (!s.sessions) s.sessions = {};
      // 迁移旧版单会话（quiz_v1 早期只存一个 S.session）到按章节的 sessions 映射
      if (s.session) {
        const o = s.session; let key;
        if (o.mode === 'exam') key = 'e:' + o.subject;
        else if (o.mode === 'practice' && o.key && o.key.indexOf('chapter:') === 0) key = 'c:' + o.subject + ':' + o.key.slice(8);
        else if (o.key === 'random') key = 'r:' + o.subject;
        else key = 'legacy:' + (o.key || 'x');
        o.key = key; o.updatedAt = Date.now();
        s.sessions[key] = o; delete s.session;
      }
      return s;
    }
  } catch (e) {}
  return defaultState();
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
function subState(id) {
  if (!S.subjects[id]) S.subjects[id] = { wrong: [], fav: [], doubt: [], mastered: [], byChapter: {}, daily: {}, examHistory: [], review: {} };
  return S.subjects[id];
}
function curSub() { return SB[cur]; }
function curState() { return subState(cur); }
let cur = SB.bio ? 'bio' : Object.keys(SB)[0];
let activeTab = 'home';

/* ---------- 工具 ---------- */
function today() { return ymd(new Date()); }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function inSet(a, id) { return a.indexOf(id) >= 0; }
function addSet(a, id) { if (!inSet(a, id)) a.push(id); }
function remSet(a, id) { const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }
function sameSet(chosen, correct) {
  const a = chosen.map(x => String(x).toUpperCase()).sort().join('');
  const b = String(correct).toUpperCase().split('').filter(c => /[A-Z]/.test(c)).sort().join('');
  return a === b;
}
function allQuestions(sub) {
  const out = [];
  for (const c of sub.chapters) for (const q of c.questions) out.push({ q, chapterName: c.name, chapterId: c.id });
  return out;
}
function qById(id) { const sub = curSub(); for (const c of sub.chapters) { const f = c.questions.find(x => x.id === id); if (f) return { q: f, chapterName: c.name, chapterId: c.id }; } return null; }
function level() { return Math.floor(S.global.xp / 200) + 1; }
function addXp(n) { S.global.xp += n; }
function cssVar(n) { return getComputedStyle(document.body).getPropertyValue(n).trim() || '#888'; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 1800); }
function md(s) {
  if (!s) return '';
  s = esc(s);
  s = s.replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/^## (.*)$/gm, '<h4>$1</h4>').replace(/^# (.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/^- (.*)$/gm, '<div>• $1</div>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

/* ---------- 成就 / 徽章 ---------- */
/* ---------- 艾宾浩斯间隔回顾 ---------- */
const REVIEW_INTERVALS = [1, 3, 7, 15, 30]; // 天 · stage 0→1→2→3→4，毕业（stage 5）移除

/* ---------- 成就 / 徽章 ---------- */
const BADGES = [
  { id: 'first', em: '🌱', nm: '初次作答', ds: '完成第 1 题' },
  { id: 'h100', em: '💯', nm: '百题斩', ds: '累计作答 100 题' },
  { id: 'h500', em: '⚔️', nm: '五百勇士', ds: '累计作答 500 题' },
  { id: 'h1000', em: '👑', nm: '千题宗师', ds: '累计作答 1000 题' },
  { id: 's7', em: '🔥', nm: '七日打卡', ds: '连续打卡 7 天' },
  { id: 's30', em: '🏆', nm: '月度坚持', ds: '连续打卡 30 天' },
  { id: 'exam90', em: '🎓', nm: '学霸附体', ds: '考试得分 ≥ 90%' },
  { id: 'clear', em: '🧹', nm: '错题清零', ds: '当前学科错题清空' },
  { id: 'm50', em: '✨', nm: '融会贯通', ds: '掌握 50 题' },
];
function totalAnswered() { let n = 0; for (const id in S.subjects) { const st = S.subjects[id]; for (const d in st.daily) n += st.daily[d].answered; } return n; }
function streak() {
  const set = new Set(S.global.checkin); if (!set.size) return 0;
  let cur = new Date();
  if (!set.has(ymd(cur))) { cur.setDate(cur.getDate() - 1); if (!set.has(ymd(cur))) return 0; }
  let s = 0; while (set.has(ymd(cur))) { s++; cur.setDate(cur.getDate() - 1); } return s;
}
function addBadge(id) { if (!inSet(S.global.badges, id)) { S.global.badges.push(id); const b = BADGES.find(x => x.id === id); if (b) toast('🎉 解锁徽章：' + b.nm); } }
function checkBadges() {
  const g = S.global, got = new Set(g.badges), ta = totalAnswered();
  const add = id => { if (!got.has(id)) { got.add(id); const b = BADGES.find(x => x.id === id); if (b) toast('🎉 解锁徽章：' + b.nm); } };
  if (ta >= 1) add('first');
  if (ta >= 100) add('h100');
  if (ta >= 500) add('h500');
  if (ta >= 1000) add('h1000');
  if (streak() >= 7) add('s7');
  if (streak() >= 30) add('s30');
  if (curState().mastered.length >= 50) add('m50');
  if (curState().wrong.length === 0 && ta > 0) add('clear');
  g.badges = Array.from(got);
}

/* ---------- 作答记录 ---------- */
function recordAnswer(q, chapterId, correct) {
  const st = curState();
  const bc = st.byChapter[chapterId] || { total: 0, correct: 0 }; bc.total++; if (correct) bc.correct++; st.byChapter[chapterId] = bc;
  const d = today(), dy = st.daily[d] || { answered: 0, correct: 0 }; dy.answered++; if (correct) dy.correct++; st.daily[d] = dy;
  if (correct) { remSet(st.wrong, q.id); addSet(st.mastered, q.id); } else { addSet(st.wrong, q.id); remSet(st.mastered, q.id); }
  addXp(correct ? 15 : 5);
  checkBadges(); save();
}

/* ---------- 导航 ---------- */
function show(tab) {
  activeTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const v = $('#view');
  if (tab === 'home') v.innerHTML = renderHome();
  else if (tab === 'bank') v.innerHTML = renderBank();
  else if (tab === 'wrong') v.innerHTML = renderWrong();
  else if (tab === 'honor') v.innerHTML = renderHonor();
  else if (tab === 'me') v.innerHTML = renderMe();
  if (tab === 'bank') bindBank();
  if (tab === 'honor') bindHonor();
  if (tab === 'wrong') bindWrong();
  v.scrollTop = 0;
}

function renderHome() {
  const st = curState(), sub = curSub();
  const saved = latestSession();
  const subjName = saved && SB[saved.subject] ? SB[saved.subject].name : '';
  const cont = saved ? `<div class="card cont-card" data-act="resume-home" style="cursor:pointer">
    <div class="row between"><div><b>📌 继续刷题</b><div class="muted small">${esc(subjName)} · ${sessionLabel(saved)} · 第 ${saved.idx + 1}/${saved.qids.length} 题</div></div>
    <button class="btn sm">继续 →</button></div></div>` : '';
  const totalQ = sub.chapters.reduce((a, c) => a + c.questions.length, 0);
  const lv = level(), xpIn = S.global.xp % 200, todayA = (st.daily[today()] || {}).answered || 0, sk = streak();
  const checked = S.global.checkin.includes(today());
  return `
  <div class="hero">
    <div class="row between"><span class="lv">Lv.${lv} · ${esc(sub.name)}</span><span class="lv">${S.global.xp} XP</span></div>
    <div class="xpbar"><i style="width:${xpIn / 200 * 100}%"></i></div>
    <div class="lv" style="margin-top:6px">距下一级还差 ${200 - xpIn} XP</div>
  </div>
  <div class="stat-grid">
    <div class="stat"><b>${totalQ}</b><span>总题数</span></div>
    <div class="stat"><b>${todayA}</b><span>今日已练</span></div>
    <div class="stat"><b>${sk}🔥</b><span>连续打卡</span></div>
  </div>
  ${cont}
  <div class="mode-grid">
    <div class="mode" data-act="start-order"><div class="em">📖</div><div class="t">顺序刷题</div><div class="d">按章节逐项过</div></div>
    <div class="mode" data-act="start-random"><div class="em">🔀</div><div class="t">乱序刷题</div><div class="d">全部/错题/收藏</div></div>
    <div class="mode" data-act="start-exam"><div class="em">⏱️</div><div class="t">考试模式</div><div class="d">限时智能组卷</div></div>
    <div class="mode" data-act="start-review"><div class="em">🔄</div><div class="t">间隔回顾</div><div class="d">待回顾 ${dueReviewIds(st).length} 题</div></div>
  </div>
  <div class="card" style="margin-top:12px">
    <div class="row between"><h3 style="margin:0">每日打卡</h3>
      <button class="btn soft sm" data-act="checkin">${checked ? '已打卡 ✓' : '立即打卡 +10'}</button></div>
    <p class="muted small" style="margin:8px 0 0">连续打卡 ${sk} 天 · 累计 ${S.global.checkin.length} 天</p>
  </div>`;
}

function renderBank() {
  const sub = curSub();
  const chOpts = '<option value="">全部章节</option>' + sub.chapters.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  return `<div class="section-title">题库检索</div>
  <div class="search"><input id="bkSearch" placeholder="输入关键词 / 选项内容…" autocomplete="off"><button class="btn ghost sm" data-act="clear-search">清空</button></div>
  <select id="bkChapter" class="subject-select" style="width:100%;margin-bottom:10px">${chOpts}</select>
  <div id="bkList"></div>`;
}
function bindBank() {
  const list = $('#bkList');
  const run = () => {
    const kw = ($('#bkSearch').value || '').trim().toLowerCase();
    const cid = $('#bkChapter').value;
    let arr = allQuestions(curSub());
    if (cid) arr = arr.filter(x => x.chapterId === cid);
    if (kw) arr = arr.filter(x => (x.q.content + ' ' + Object.values(x.q.options).join(' ')).toLowerCase().includes(kw));
    arr = arr.slice(0, 200);
    if (!arr.length) { list.innerHTML = '<div class="empty">没有匹配的题目</div>'; return; }
    list.innerHTML = arr.map(x => `<div class="qitem" data-act="qview" data-id="${x.q.id}">
      <div class="q">${esc(x.q.content)}</div>
      <div class="meta"><span class="tag">${esc(x.chapterName)}</span><span class="tag">${x.q.multi ? '多选' : '单选'}</span></div></div>`).join('');
  };
  $('#bkSearch').addEventListener('input', run);
  $('#bkChapter').addEventListener('change', run);
  run();
}

let wrongTab = 'wrong';
function renderWrong() {
  const st = curState();
  const tabs = [['wrong', '❌ 错题', st.wrong.length], ['fav', '⭐ 收藏', st.fav.length], ['doubt', '❓ 疑点', st.doubt.length]];
  const head = tabs.map(([k, n, c]) => `<button class="btn ${wrongTab === k ? '' : 'ghost'} sm" data-act="wtab" data-k="${k}" style="flex:1">${n} ${c}</button>`).join('');
  return `<div class="section-title">我的题目</div><div class="row" style="gap:8px;margin-bottom:10px">${head}</div><div id="wList"></div>`;
}
function bindWrong() {
  const list = $('#wList');
  const map = { wrong: curState().wrong, fav: curState().fav, doubt: curState().doubt };
  const ids = map[wrongTab] || [];
  if (!ids.length) { list.innerHTML = '<div class="empty">这里还空空如也</div>'; return; }
  list.innerHTML = ids.map(id => { const x = qById(id); if (!x) return ''; return `<div class="qitem" data-act="qview" data-id="${id}">
    <div class="q">${esc(x.q.content)}</div>
    <div class="meta"><span class="tag">${esc(x.chapterName)}</span></div></div>`; }).join('');
}

function renderHonor() {
  const g = S.global, st = curState(), lv = level(), xpIn = S.global.xp % 200, sk = streak();
  const badges = BADGES.map(b => { const got = inSet(g.badges, b.id); return `<div class="badge ${got ? '' : 'locked'}"><div class="em">${b.em}</div><div class="nm">${b.nm}</div><div class="ds">${b.ds}</div></div>`; }).join('');
  const eh = (st.examHistory || []).slice().reverse();
  const ehHtml = eh.length ? eh.map(e => `<div class="exam-item row between"><div><div class="score-big" style="color:${e.score >= 60 ? 'var(--ok)' : 'var(--bad)'}">${e.score} 分</div><span class="muted small">${new Date(e.date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 答对 ${e.right}/${e.total}</span></div><span class="tag">${e.minutes}分钟</span></div>`).join('') : '<div class="empty">还没有考试记录</div>';
  // 热度图：近 14 天，颜色越红 = 刷题越多（按 ×10 标准，共 6 档）
  const hmDays = []; for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); hmDays.push(d); }
  const hmHtml = hmDays.map(d => {
    const cnt = (st.daily[ymd(d)] || {}).answered || 0;
    let clr = 'var(--surface2)';
    if (cnt > 0 && cnt <= 30) clr = 'var(--warm)';
    else if (cnt <= 100) clr = 'var(--bad-soft)';
    else if (cnt <= 200) clr = 'var(--bad)';
    else if (cnt <= 500) clr = '#c62828';
    else clr = '#5b21b6';
    return `<div class="hm-cell" style="background:${clr}" title="${ymd(d)} · ${cnt} 题"></div>`;
  }).join('');
  return `
  <div class="section-title">成就与荣誉</div>
  <div class="hero"><div class="row between"><span class="lv">Lv.${lv} · ${esc(curSub().name)}</span><span class="lv">${g.xp} XP</span></div>
    <div class="xpbar"><i style="width:${xpIn / 200 * 100}%"></i></div>
    <div class="lv" style="margin-top:6px">距下一级还差 ${200 - xpIn} XP · 🔥连续 ${sk} 天</div></div>
  <div class="card"><h3>刷题热度（近 14 天）</h3><div class="heatmap">${hmHtml}</div>
    <div class="hm-legend">刷得越少&nbsp;→&nbsp;越多 <i style="background:var(--surface2);border:1px solid var(--border)"></i> <i style="background:var(--warm)"></i> <i style="background:var(--bad-soft)"></i> <i style="background:var(--bad)"></i> <i style="background:#c62828"></i> <i style="background:#5b21b6"></i></div></div>
  <div class="card"><h3>徽章墙</h3><div class="badge-grid">${badges}</div></div>
  <div class="card"><h3>薄弱知识点（章节掌握度）</h3><canvas id="radar" width="320" height="300"></canvas>
    <div id="chMastery" class="small"></div></div>
  <div class="card"><h3>正确率趋势（近 14 天）</h3><canvas id="trend" width="320" height="180"></canvas></div>
  <div class="card"><h3>历史成绩</h3>${ehHtml}</div>`;
}
function bindHonor() {
  const sub = curSub(), st = curState();
  const labels = sub.chapters.map(c => c.name.replace(/^第.+?章\s*/, ''));
  const vals = sub.chapters.map(c => { const bc = st.byChapter[c.id]; return bc && bc.total ? Math.round(bc.correct / bc.total * 100) : 0; });
  drawRadar($('#radar'), labels, vals);
  let mh = '';
  sub.chapters.forEach(c => { const bc = st.byChapter[c.id]; const pct = bc && bc.total ? Math.round(bc.correct / bc.total * 100) : 0; const w = bc && bc.total ? pct : 0; mh += `<div style="margin:6px 0"><div class="row between"><span>${esc(c.name)}</span><span class="muted">${bc ? bc.correct + '/' + bc.total : '未练'}</span></div><div class="xpbar" style="background:var(--surface2)"><i style="width:${w}%;background:${pct >= 60 ? 'var(--ok)' : pct >= 30 ? 'var(--warn)' : 'var(--bad)'}"></i></div></div>`; });
  $('#chMastery').innerHTML = mh;
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const tdata = days.map(d => { const dy = st.daily[ymd(d)]; return dy && dy.answered ? Math.round(dy.correct / dy.answered * 100) : null; });
  drawTrend($('#trend'), tdata);

  // 热度图在窄屏会横向溢出：让鼠标滚轮也能横向滚动它（不再只能拖滚动条）
  const hm = $('.heatmap');
  if (hm) {
    hm.addEventListener('wheel', e => {
      if (hm.scrollWidth - hm.clientWidth < 2) return;            // 没溢出就不拦截，交给页面正常纵向滚动
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const max = hm.scrollWidth - hm.clientWidth;
      const next = hm.scrollLeft + d;
      if (next > 0 && next < max) { hm.scrollLeft = next; e.preventDefault(); }  // 中间段：纵向滚轮→横向滚动
    }, { passive: false });
  }
}

function renderMe() {
  const g = S.global, st = curState();
  const fonts = [['s', '小'], ['m', '中'], ['l', '大']];
  return `
  <div class="section-title">我的</div>
  <div class="card">
    <h3>显示设置</h3>
    <div class="set-row"><span>🌙 暗色模式</span><div class="switch ${g.settings.dark ? 'on' : ''}" data-act="toggle-dark"><i></i></div></div>
    <div class="set-row"><span>🔠 字号</span><div class="wrap">${fonts.map(([k, n]) => `<button class="btn ${g.settings.font === k ? '' : 'ghost'} sm" data-act="set-font" data-k="${k}">${n}</button>`).join('')}</div></div>
  </div>
  <div class="card">
    <h3>学习数据</h3>
    <div class="row between"><span class="muted small">当前学科错题</span><b>${st.wrong.length}</b></div>
    <div class="row between"><span class="muted small">当前学科收藏</span><b>${st.fav.length}</b></div>
    <div class="row between"><span class="muted small">累计作答</span><b>${totalAnswered()}</b></div>
  </div>
  <div class="card">
    <h3>危险区</h3>
    <button class="btn ghost" data-act="reset">清空全部学习进度</button>
  </div>
  <div class="card">
    <h3>关于</h3>
    <p class="muted small" style="margin:0">刷题记 · 纯本地个人学习站。数据来自本地题库快照，状态仅存于本机浏览器。题库结构后续补全后可重新生成 data.js 刷新。</p>
  </div>`;
}

/* ---------- 弹层 ---------- */
function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }

function openQDetail(qid) {
  const x = qById(qid); if (!x) return;
  const st = curState(), q = x.q;
  const isFav = inSet(st.fav, qid), isWrong = inSet(st.wrong, qid), isDoubt = inSet(st.doubt, qid);
  const rv = st.review ? st.review[qid] : null;
  const wrongAns = rv ? rv.wrongAns || [] : [];
  let optHtml = ''; for (const k of Object.keys(q.options)) {
    let cls = 'opt';
    if (k === q.correct) cls += ' correct';
    else if (wrongAns.indexOf(k) >= 0) cls += ' wrong';
    optHtml += `<div class="${cls}"><div class="k">${k}</div><div class="v">${esc(q.options[k])}</div></div>`;
  }
  openModal(`<h3>${esc(x.chapterName)}</h3>
    <div class="qstem">${esc(q.content)}</div>
    ${q.images && q.images.length ? q.images.map(im => `<img class="qimg" src="${esc(im)}" onerror="this.style.display='none'">`).join('') : ''}
    ${optHtml}
    <div class="ans-line ok">正确答案：${esc(q.correct)}</div>
    ${q.explanation ? `<div class="exp"><h4>解析</h4>${md(q.explanation)}</div>` : ''}
    <div class="wrap" style="margin-top:12px">
      <button class="btn soft sm" data-act="toggle-fav" data-id="${qid}">${isFav ? '★ 取消收藏' : '☆ 收藏'}</button>
      <button class="btn soft sm" data-act="toggle-doubt" data-id="${qid}">${isDoubt ? '已标记疑点' : '标记疑点'}</button>
      <button class="btn soft sm" data-act="remove-wrong" data-id="${qid}">${isWrong ? '移出错题' : '非错题'}</button>
    </div>
    <button class="btn ghost" data-act="close-modal" style="margin-top:8px">关闭</button>`);
}

/* ---------- 练习设置弹层 ---------- */
function orderSetup() {
  const sub = curSub(), st = curState();
  const items = sub.chapters.map(c => {
    const total = c.questions.length;
    const bc = st.byChapter[c.id];
    const correct = bc ? bc.correct : 0;
    const wrong = bc ? bc.total - bc.correct : 0;
    const pct = total ? Math.round((correct + wrong) / total * 100) : 0;
    return `<div class="qitem" data-act="chapter" data-id="${c.id}">
      <div class="q">${esc(c.name)}</div>
      <div class="ch-prog">
        <div class="ch-prog-bar"><i style="width:${total ? correct/total*100 : 0}%;background:var(--ok)"></i><i style="width:${total ? wrong/total*100 : 0}%;background:var(--bad)"></i></div>
        <span class="pct">${pct}%</span>
      </div></div>`;
  }).join('');
  openModal(`<h3>顺序刷题 · 选择章节</h3>${items}<button class="btn ghost" data-act="close-modal">关闭</button>`);
}
/* 章内题号导航：点击某章后弹出圆圈，定位到具体题目 */
function openChapterNav(c) {
  const st = curState();
  const cells = c.questions.map((q, i) => {
    let cls = 'qn';
    if (inSet(st.wrong, q.id)) cls += ' wrong';
    else if (inSet(st.mastered, q.id)) cls += ' correct';
    return `<button class="${cls}" data-act="jump-q" data-id="${c.id}" data-qi="${i}" aria-label="第 ${i + 1} 题">${i + 1}</button>`;
  }).join('');
  openModal(`<div class="qnav-head">
      <button class="back" data-act="back-chapters">← 返回章节</button>
      <div class="ttl">${esc(c.name)} · 题号导航</div>
    </div>
    <p class="muted small">点击题号直接定位到该题开始练习。绿底=已答对，红底=答错过，白底黑线=未刷。</p>
    <div class="qnav">${cells}</div>
    <div class="qnav-legend">
      <span><i class="dot"></i>未刷</span>
      <span><i class="dot ok"></i>已答对</span>
      <span><i class="dot bad"></i>答错过</span>
    </div>`);
}
/* 跳转到指定题号开始练习（保留已有作答进度，如有） */
function jumpToQuestion(c, qi) {
  const key = makeSessionKey('practice', c.id);
  const saved = getSession(key);
  // 题库顺序始终以「当前章节题目」为准，跳转题号 qi 才能与池内下标严格对齐（避免 data.js 重排后错位）
  const pool = c.questions.map(q => ({ q, chapterName: c.name, chapterId: c.id }));
  let answers = {};
  if (saved && saved.answers) {
    for (const it of pool) if (saved.answers[it.q.id]) answers[it.q.id] = saved.answers[it.q.id];
  }
  const st = curState();
  // 导航色（mastered/wrong）与题内状态对齐：已知作答结果的题，点进去直接显示已揭晓的作答痕迹
  for (const it of pool) {
    const id = it.q.id;
    if (answers[id]) continue;
    if (inSet(st.mastered, id)) answers[id] = { chosen: String(it.q.correct).toUpperCase().split('').filter(x => /[A-Z]/.test(x)), correct: true, revealed: true };
    else if (inSet(st.wrong, id)) answers[id] = { chosen: [], correct: false, revealed: true };
  }
  P = { pool, mode: 'practice', idx: Math.min(qi, pool.length - 1), answers, modeOpt: { chapterId: c.id }, submitted: false, start: Date.now(), timer: null, timeLeft: 0, sessionKey: key };
  saveSession();
  closeModal();
  $('#player').classList.remove('hidden');
  renderPlayer();
}
function randomSetup() {
  const st = curState();
  openModal(`<h3>乱序刷题 · 选择题源</h3>
    <label class="set-row"><span>📚 全部题目</span><input type="checkbox" class="src" value="all" checked></label>
    <label class="set-row"><span>❌ 仅错题 (${st.wrong.length})</span><input type="checkbox" class="src" value="wrong"></label>
    <label class="set-row"><span>⭐ 仅收藏 (${st.fav.length})</span><input type="checkbox" class="src" value="fav"></label>
    <label class="set-row"><span>❓ 仅疑点 (${st.doubt.length})</span><input type="checkbox" class="src" value="doubt"></label>
    <div class="set-row"><span>数量上限</span><input type="number" id="rdLimit" value="20" min="1" style="width:80px"></div>
    <button class="btn" data-act="random-go">开始</button>
    <button class="btn ghost" data-act="close-modal">取消</button>`);
}
function examSetup() {
  const all = allQuestions(curSub());
  const singles = all.filter(x => !x.q.multi).length, multis = all.filter(x => x.q.multi).length;
  openModal(`<h3>考试设置</h3>
    <div class="set-row"><span>单选题数量</span><input type="number" id="exSingle" value="${Math.min(20, singles)}" min="0" max="${singles}" style="width:80px"></div>
    <div class="set-row"><span>多选题数量</span><input type="number" id="exMulti" value="${Math.min(5, multis)}" min="0" max="${multis}" style="width:80px"></div>
    <div class="set-row"><span>考试时长(分钟)</span><input type="number" id="exMin" value="30" min="1" max="180" style="width:80px"></div>
    <p class="muted small">当前题库：单选 ${singles} 题，多选 ${multis} 题</p>
    <button class="btn" data-act="exam-go">开始考试</button>
    <button class="btn ghost" data-act="close-modal">取消</button>`);
}

/* ---------- 播放器 ---------- */
let P = null;

/* ---------- 间隔回顾（艾宾浩斯） ---------- */
function dueReviewIds(st) {
  const now = Date.now(), ids = [];
  for (const qid in (st.review || {})) { if (st.review[qid].nextReview <= now) ids.push(qid); }
  return ids;
}
function updateReview(q, correct, chosen) {
  const st = curState();
  if (!st.review) st.review = {};
  if (correct) {
    if (st.review[q.id]) {
      const r = st.review[q.id];
      r.stage = Math.min(r.stage + 1, REVIEW_INTERVALS.length);
      if (r.stage >= REVIEW_INTERVALS.length) delete st.review[q.id];
      else r.nextReview = Date.now() + REVIEW_INTERVALS[r.stage] * 86400000;
    }
  } else {
    if (!st.review[q.id]) st.review[q.id] = { stage: 0, wrongAns: [] };
    const r = st.review[q.id];
    r.stage = 0;
    r.nextReview = Date.now() + REVIEW_INTERVALS[0] * 86400000;
    r.wrongAns = (chosen || []).slice();
  }
}
function startReview() {
  const st = curState();
  const due = dueReviewIds(st);
  if (!due.length) { toast('暂无待回顾的题目，错题会在 1 天后自动进入队列'); return; }
  const pool = [];
  for (const qid of due) {
    const x = qById(qid);
    if (!x) { delete st.review[qid]; continue; }
    pool.push(x);
  }
  if (!pool.length) { toast('所有回顾题已失效，队列已清空'); return; }
  closeModal();
  startPractice(shuffle(pool), 'practice', {}, null);
  P.reviewMode = true;
}

/* 练习进度持久化（断点续练 · 按「科目+章节」分别缓存）
   旧版只存一个全局会话，切到别的章节会把前一个覆盖，导致回不去。
   现改为 sessions 映射：key = c:<科目>:<章节> / r:<科目> / e:<科目>，
   每个章节独立保留进度，互不影响，且跨科目各自保留。 */
let pendingResume = null;
function makeSessionKey(mode, chapterId) {
  if (mode === 'exam') return 'e:' + cur;
  if (mode === 'practice' && chapterId) return 'c:' + cur + ':' + chapterId;
  return 'r:' + cur;
}
function getSession(key) { return S.sessions[key] || null; }
function buildPoolFromSession(s) {
  const pool = [];
  for (const e of s.qids) { const x = qById(e.id); if (!x) return null; pool.push({ q: x.q, chapterName: e.chapterName, chapterId: e.chapterId }); }
  return pool;
}
function sessionLabel(s) {
  if (s.mode === 'exam') return '考试模式';
  if (s.mode === 'review') return '作答回顾';
  if (s.key && s.key.charAt(0) === 'c') {
    const cid = s.key.slice(s.key.indexOf(':', 2) + 1); const ch = curSub().chapters.find(c => c.id === cid);
    return '顺序刷题 · ' + (ch ? ch.name : '章节');
  }
  if (s.key && s.key.charAt(0) === 'r') return '乱序刷题';
  return '练习';
}
/* 章节顺序练习的「继续」指针：指向第一道尚未作答的题（与最后浏览位置解耦，
   避免通过题号导航跳题时，把「已刷到的进度」覆盖成最后点开的那个圆圈） */
function nextTodoIdx(pool, answers) {
  for (let i = 0; i < pool.length; i++) { const a = answers[pool[i].q.id]; if (!a || !a.revealed) return i; }
  return pool.length - 1;
}
function saveSession() {
  if (!P) return;
  const key = P.sessionKey;
  const idx = (P.mode === 'practice' && key && key.charAt(0) === 'c') ? nextTodoIdx(P.pool, P.answers) : P.idx;
  S.sessions[key] = {
    subject: cur, key, mode: P.mode, idx,
    qids: P.pool.map(it => ({ id: it.q.id, chapterId: it.chapterId, chapterName: it.chapterName })),
    modeOpt: P.modeOpt, start: P.start, answers: P.answers, timeLeft: P.timeLeft,
    updatedAt: Date.now()
  };
  save();
}
function clearSession() {
  if (P && P.sessionKey && S.sessions[P.sessionKey]) { delete S.sessions[P.sessionKey]; save(); }
}
function clearSessionKey(key) { if (S.sessions[key]) { delete S.sessions[key]; save(); } }
/* 全局最近一次缓存（用于首页「继续刷题」入口，跨科目也按时间取最新） */
function latestSession(subject) {
  const subj = subject || cur;
  let best = null;
  for (const k in S.sessions) {
    const s = S.sessions[k];
    if (!s.qids || !s.qids.length) continue;
    if (s.subject !== subj) continue;
    if (!best || s.updatedAt > best.updatedAt) best = s;
  }
  return best;
}
function resumeSession(saved) {
  cur = saved.subject; const sel = $('#subjectSelect'); if (sel) sel.value = cur;
  const pool = buildPoolFromSession(saved);
  if (!pool) { clearSessionKey(saved.key); toast('进度已失效，重新开始'); return; }
  P = {
    pool, mode: saved.mode, idx: Math.min(saved.idx, pool.length - 1),
    answers: saved.answers || {}, modeOpt: saved.modeOpt || {},
    submitted: saved.mode === 'review', start: Date.now(), timer: null, timeLeft: 0, sessionKey: saved.key
  };
  if (saved.mode === 'exam' && !P.submitted) {
    P.timeLeft = (P.modeOpt.minutes || 30) * 60;
    P.timer = setInterval(() => { P.timeLeft--; const el = $('#examTimer'); if (el) el.textContent = '⏱️ ' + fmtTime(P.timeLeft); if (P.timeLeft <= 0) { clearInterval(P.timer); submitExam(); } }, 1000);
  }
  saveSession();
  $('#player').classList.remove('hidden');
  renderPlayer();
}
function promptResume(saved, freshStartFn) {
  pendingResume = { saved, freshStartFn };
  openModal(`<h3>继续上次练习？</h3>
    <p class="muted">${sessionLabel(saved)} · 上次进行到第 ${saved.idx + 1}/${saved.qids.length} 题</p>
    <button class="btn" data-act="resume-yes">继续（第 ${saved.idx + 1} 题）</button>
    <button class="btn ghost" data-act="resume-no">重新开始</button>`);
}
function requestStart(pool, mode, opt, chapterId) {
  const key = makeSessionKey(mode, chapterId);
  const saved = getSession(key);
  if (saved && saved.mode === mode && saved.qids && saved.qids.length) promptResume(saved, () => startPractice(pool, mode, opt, key));
  else startPractice(pool, mode, opt, key);
}

function startPractice(pool, mode, opt, sessionKey) {
  if (!pool.length) { toast('没有可练习的题目'); return; }
  P = { pool, mode, idx: 0, answers: {}, modeOpt: opt || {}, submitted: false, start: Date.now(), timer: null, timeLeft: 0, sessionKey: sessionKey || 'adhoc' };
  if (mode === 'exam') {
    P.timeLeft = (opt.minutes || 30) * 60;
    P.timer = setInterval(() => { P.timeLeft--; const el = $('#examTimer'); if (el) el.textContent = '⏱️ ' + fmtTime(P.timeLeft); if (P.timeLeft <= 0) { clearInterval(P.timer); submitExam(); } }, 1000);
  }
  saveSession();
  $('#player').classList.remove('hidden');
  renderPlayer();
}
function openPlayer() { $('#player').classList.remove('hidden'); }
function closePlayer() { if (P && P.timer) clearInterval(P.timer); $('#player').classList.add('hidden'); }
function renderPlayer() {
  const p = $('#player'), it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || {};
  const st = curState();
  const isFav = inSet(st.fav, q.id), isDoubt = inSet(st.doubt, q.id);
  let head = '';
  if (P.mode === 'exam') {
    head = `<div class="phead-row"><span class="pill">${P.idx + 1}/${P.pool.length}</span>
      <span id="examTimer" class="pill">⏱️ ${fmtTime(P.timeLeft)}</span>
      <button class="btn soft sm" data-act="sheet">答题卡</button>
      <button class="btn ghost sm" data-act="exit-player">✕</button></div>`;
  } else if (P.mode === 'review') {
    head = `<div class="phead-row"><span class="pill">${P.idx + 1}/${P.pool.length} · 作答回顾</span><button class="btn soft sm" data-act="sheet">答题卡</button><button class="btn ghost sm" data-act="exit-player">✕</button></div>`;
  } else {
    head = `<div class="phead-row"><span class="pill">${P.idx + 1}/${P.pool.length} · ${esc(it.chapterName)}</span><button class="btn soft sm" data-act="sheet">答题卡</button><button class="btn ghost sm" data-act="exit-player">✕</button></div>`;
  }
  let body = `<div class="qstem">${esc(q.content)}</div>`;
  // 间隔回顾：上轮错选提示
  const rv = st.review ? st.review[q.id] : null;
  if (rv && rv.wrongAns && rv.wrongAns.length) body += `<div class="rv-hint">📝 上次错选：${esc(rv.wrongAns.join('、'))} · 已进入第 ${rv.stage + 1} 轮回顾</div>`;
  if (q.images && q.images.length) for (const im of q.images) body += `<img class="qimg" src="${esc(im)}" onerror="this.style.display='none'">`;
  const keys = Object.keys(q.options || {});
  let optHtml = '';
  for (const k of keys) {
    const v = q.options[k];
    let cls = 'opt', actAttr = '';
    if (a.revealed) { if (k === q.correct) cls += ' correct'; else if (a.chosen && a.chosen.includes(k)) cls += ' wrong'; else cls += ' dim'; }
    else { if (a.chosen && a.chosen.includes(k)) cls += ' sel'; actAttr = P.mode === 'exam' ? 'data-act="pick-exam"' : 'data-act="pick"'; }
    optHtml += `<div class="${cls}" ${actAttr} data-k="${k}"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`;
  }
  body += optHtml;
  if (a.revealed) {
    body += `<div class="ans-line ${a.correct ? 'ok' : 'bad'}">${a.correct ? '✅ 回答正确' : '❌ 回答错误'} · 正确答案：${esc(q.correct)}</div>`;
    if (q.explanation) body += `<div class="exp"><h4>解析</h4>${md(q.explanation)}</div>`;
  } else if (q.explanation && P.mode !== 'exam') {
    body += `<details class="exp"><summary style="cursor:pointer;font-weight:700">提前看解析</summary>${md(q.explanation)}</details>`;
  }
  let foot = '';
  if (P.mode === 'exam') {
    if (P.submitted) foot = `<button class="btn ghost" data-act="prev">上一题</button><button class="btn" data-act="next">下一题</button>`;
    else foot = `<button class="btn ghost" data-act="prev">上一题</button><button class="btn" data-act="submit-exam">交卷</button>`;
  } else if (P.mode === 'review') {
    foot = `<button class="btn ghost" data-act="prev">上一题</button><button class="btn" data-act="next">下一题</button>`;
  } else {
    if (!a.revealed) foot = `<button class="btn ghost" data-act="reveal">看答案</button><button class="btn" data-act="confirm">确认</button>`;
    else foot = `<button class="btn" data-act="next">${P.idx >= P.pool.length - 1 ? '完成' : '下一题'}</button>`;
  }
  const prog = Math.round((P.idx + 1) / P.pool.length * 100);
  body += `<div class="q-actions">
    <button class="chip ${isFav ? 'on' : ''}" data-act="pfav" data-id="${q.id}">${isFav ? '★ 已收藏' : '☆ 收藏'}</button>
    <button class="chip ${isDoubt ? 'on' : ''}" data-act="pdoubt" data-id="${q.id}">${isDoubt ? '❓ 已标记' : '❓ 疑点'}</button>
  </div>`;
  body += `<div class="swipe-hint">← 左右滑动切换题目 →</div>`;
  p.innerHTML = `<div class="phead">${head}<div class="pbar"><i style="width:${prog}%"></i></div></div><div class="pbody">${body}</div><div class="pfoot">${foot}</div>`;
}
function pick(k) {
  const q = P.pool[P.idx].q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
  if (q.multi) { const i = a.chosen.indexOf(k); if (i >= 0) a.chosen.splice(i, 1); else a.chosen.push(k); }
  else a.chosen = [k];
  renderPlayer();
}
function confirmAns() {
  const it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
  if (!a.chosen || !a.chosen.length) { toast('请先选择答案'); return; }
  const correct = sameSet(a.chosen, q.correct);
  a.correct = correct; a.revealed = true;
  recordAnswer(q, it.chapterId, correct);
  updateReview(q, correct, a.chosen);
  saveSession();
  renderPlayer();
}
function revealAns() {
  const it = P.pool[P.idx], q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
  // 仅用于正确显示，不调 recordAnswer——"看答案"不是正式作答
  a.correct = a.chosen && a.chosen.length ? sameSet(a.chosen, q.correct) : false;
  a.revealed = true; saveSession(); renderPlayer();
}
function nextQ() {
  // 考试未交卷时，最后一题不允许“下一题”结束，必须点「交卷」评分
  if (P.mode === 'exam' && !P.submitted) {
    if (P.idx >= P.pool.length - 1) { toast('请点击「交卷」结束考试'); return; }
    P.idx++; saveSession(); renderPlayer(); return;
  }
  if (P.idx >= P.pool.length - 1) finishPractice(); else { P.idx++; saveSession(); renderPlayer(); }
}
function prevQ() { if (P.idx > 0) { P.idx--; saveSession(); renderPlayer(); } }
function finishPractice() { clearSession(); closePlayer(); show(activeTab); toast('本组练习完成 🎉'); }
function submitExam() {
  if (!P) return;
  if (P.timer) clearInterval(P.timer);
  P.submitted = true;
  let right = 0, total = P.pool.length;
  for (const it of P.pool) {
    const q = it.q, a = P.answers[q.id] || (P.answers[q.id] = { chosen: [] });
    const correct = a.chosen && a.chosen.length ? sameSet(a.chosen, q.correct) : false;
    a.correct = correct; a.revealed = true; if (correct) right++;
    recordAnswer(q, it.chapterId, correct);
    updateReview(q, correct, a.chosen);
  }
  const score = total ? Math.round(right / total * 100) : 0;
  const st = curState();
  st.examHistory = st.examHistory || [];
  st.examHistory.push({ date: Date.now(), score, right, total, minutes: P.modeOpt.minutes || Math.round((Date.now() - P.start) / 60000) });
  if (st.examHistory.length > 50) st.examHistory.shift();
  if (score >= 90) addBadge('exam90');
  checkBadges(); save(); clearSession();
  closePlayer();
  openModal(`<h3>考试结束</h3>
    <div class="score-big" style="color:${score >= 60 ? 'var(--ok)' : 'var(--bad)'}">${score} 分</div>
    <p class="muted">答对 ${right}/${total} 题 · 用时 ${P.modeOpt.minutes || Math.round((Date.now() - P.start) / 60000)} 分钟</p>
    <button class="btn" data-act="review-exam">查看作答回顾</button>
    <button class="btn ghost" data-act="exam-back">返回成就</button>`);
}
function reviewExam() { openPlayer(); P.mode = 'review'; P.idx = 0; renderPlayer(); }
function openSheet() {
  const cells = P.pool.map((it, i) => {
    const a = P.answers[it.q.id]; let cls = 'cell';
    if (a) { if (a.revealed) cls += ' ' + (a.correct ? 'right' : 'wrong'); else if (a.chosen && a.chosen.length) cls += ' done'; }
    return `<div class="${cls}" data-act="sheet-go" data-i="${i}">${i + 1}</div>`;
  }).join('');
  openModal(`<h3>答题卡</h3><div class="sheet">${cells}</div><button class="btn ghost" data-act="close-modal">关闭</button>`);
}

/* ---------- 可视化 ---------- */
function drawRadar(canvas, labels, vals) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) / 2 - 38;
  const n = labels.length; if (!n) return;
  ctx.clearRect(0, 0, W, H);
  const text = cssVar('--text'), grid = cssVar('--border'), fill = cssVar('--primary');
  for (let r = 1; r <= 4; r++) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const ang = -Math.PI / 2 + i * 2 * Math.PI / n; const rr = R * r / 4; const x = cx + rr * Math.cos(ang), y = cy + rr * Math.sin(ang); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath(); ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + i * 2 * Math.PI / n;
    const rr = R * (vals[i] || 0) / 100; const x = cx + rr * Math.cos(ang), y = cy + rr * Math.sin(ang);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    const lx = cx + (R + 16) * Math.cos(ang), ly = cy + (R + 16) * Math.sin(ang);
    ctx.fillStyle = text; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(labels[i].slice(0, 6) + (labels[i].length > 6 ? '…' : ''), lx, ly);
  }
  ctx.closePath(); ctx.fillStyle = fill; ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = fill; ctx.lineWidth = 2; ctx.stroke();
}
function drawTrend(canvas, data) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, pad = 24;
  ctx.clearRect(0, 0, W, H);
  const text = cssVar('--muted'), grid = cssVar('--border'), line = cssVar('--ok');
  const pts = data.map((v, i) => v == null ? null : { x: pad + i * (W - pad * 2) / (data.length - 1), y: H - pad - v / 100 * (H - pad * 2) });
  ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();
  ctx.fillStyle = text; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('0%', pad - 14, H - pad + 3); ctx.fillText('100%', pad - 14, pad);
  ctx.beginPath(); let started = false;
  pts.forEach(p => { if (!p) { started = false; return; } started ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); started = true; });
  ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke();
  pts.forEach(p => { if (!p) return; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fillStyle = line; ctx.fill(); });
}

/* ---------- 事件分发 ---------- */
function onAct(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (act === 'goto') { closeModal(); show(t.dataset.tab); return; }
  if (act === 'close-modal') { pendingResume = null; closeModal(); return; }
  if (act === 'resume-home') { const s = latestSession(); if (s) resumeSession(s); return; }
  if (act === 'resume-yes') { const p = pendingResume; pendingResume = null; closeModal(); if (p) resumeSession(p.saved); return; }
  if (act === 'resume-no') { const p = pendingResume; pendingResume = null; closeModal(); if (p) { clearSessionKey(p.saved.key); p.freshStartFn(); } return; }
  if (act === 'checkin') { doCheckin(); return; }
  if (act === 'start-order') { orderSetup(); return; }
  if (act === 'start-random') { randomSetup(); return; }
  if (act === 'start-exam') { examSetup(); return; }
  if (act === 'start-review') { startReview(); return; }
  if (act === 'chapter') {
    const c = curSub().chapters.find(x => x.id === t.dataset.id);
    if (c) openChapterNav(c);
    return;
  }
  if (act === 'jump-q') {
    const c = curSub().chapters.find(x => x.id === t.dataset.id);
    const qi = parseInt(t.dataset.qi) || 0;
    if (c) jumpToQuestion(c, qi);
    return;
  }
  if (act === 'back-chapters') { orderSetup(); return; }
  if (act === 'clear-search') { $('#bkSearch').value = ''; $('#bkChapter').value = ''; $('#bkSearch').dispatchEvent(new Event('input')); return; }
  if (act === 'qview') { openQDetail(t.dataset.id); return; }
  if (act === 'toggle-fav') { const st = curState(), id = t.dataset.id; inSet(st.fav, id) ? remSet(st.fav, id) : addSet(st.fav, id); save(); closeModal(); toast(inSet(st.fav, id) ? '已收藏 ⭐' : '已取消收藏'); if ($('#player').classList.contains('hidden')) show(activeTab); else renderPlayer(); return; }
  if (act === 'toggle-doubt') { const st = curState(), id = t.dataset.id; inSet(st.doubt, id) ? remSet(st.doubt, id) : addSet(st.doubt, id); save(); closeModal(); toast(inSet(st.doubt, id) ? '已标记疑点 ❓' : '已取消疑点'); if ($('#player').classList.contains('hidden')) show(activeTab); else renderPlayer(); return; }
  if (act === 'remove-wrong') { const st = curState(), id = t.dataset.id; remSet(st.wrong, id); save(); closeModal(); toast('已移出错题'); if ($('#player').classList.contains('hidden')) show(activeTab); else renderPlayer(); return; }
  if (act === 'wtab') { wrongTab = t.dataset.k; show('wrong'); return; }
  if (act === 'random-go') {
    const srcs = Array.from(document.querySelectorAll('.src')).filter(c => c.checked).map(c => c.value);
    let base = allQuestions(curSub());
    let pool;
    if (srcs.includes('all') || !srcs.length) pool = base;
    else { const ids = new Set(); const st = curState(); srcs.forEach(s => { (st[s] || []).forEach(id => ids.add(id)); }); pool = base.filter(x => ids.has(x.q.id)); }
    const limit = Math.max(1, parseInt($('#rdLimit').value) || 20);
    pool = shuffle(pool).slice(0, limit);
    closeModal(); requestStart(pool, 'practice', {}, null); return;
  }
  if (act === 'exam-go') {
    const singles = Math.min(parseInt($('#exSingle').value) || 0, allQuestions(curSub()).filter(x => !x.q.multi).length);
    const multis = Math.min(parseInt($('#exMulti').value) || 0, allQuestions(curSub()).filter(x => x.q.multi).length);
    const minutes = Math.max(1, parseInt($('#exMin').value) || 30);
    let pool = [];
    const all = allQuestions(curSub());
    pool = pool.concat(shuffle(all.filter(x => !x.q.multi)).slice(0, singles));
    pool = pool.concat(shuffle(all.filter(x => x.q.multi)).slice(0, multis));
    pool = shuffle(pool);
    closeModal(); requestStart(pool, 'exam', { minutes, single: singles, multi: multis }, null); return;
  }
  if (act === 'pick' || act === 'pick-exam') { pick(t.dataset.k); return; }
  if (act === 'confirm') { confirmAns(); return; }
  if (act === 'reveal') { revealAns(); return; }
  if (act === 'next') { nextQ(); return; }
  if (act === 'prev') { prevQ(); return; }
  if (act === 'submit-exam') { submitExam(); return; }
  if (act === 'pfav' || act === 'pdoubt') {
    const st = curState(), id = t.dataset.id, set = act === 'pfav' ? 'fav' : 'doubt';
    inSet(st[set], id) ? remSet(st[set], id) : addSet(st[set], id);
    save(); renderPlayer();
    const on = inSet(st[set], id);
    toast(act === 'pfav' ? (on ? '已收藏 ⭐' : '已取消收藏') : (on ? '已标记疑点 ❓' : '已取消疑点'));
    return;
  }
  if (act === 'sheet') { openSheet(); return; }
  if (act === 'sheet-go') { P.idx = parseInt(t.dataset.i); closeModal(); renderPlayer(); return; }
  if (act === 'exit-player') { saveSession(); closePlayer(); return; }
  if (act === 'review-exam') { reviewExam(); return; }
  if (act === 'exam-back') { closeModal(); show('honor'); return; }
  if (act === 'toggle-dark') { S.global.settings.dark = !S.global.settings.dark; applySettings(); save(); show('me'); return; }
  if (act === 'set-font') { S.global.settings.font = t.dataset.k; applySettings(); save(); show('me'); return; }
  if (act === 'reset') {
    if (confirm('确定清空全部学习进度？此操作不可恢复。')) { S = defaultState(); save(); applySettings(); show('home'); toast('已清空'); }
    return;
  }
}
function doCheckin() {
  const d = today(); if (inSet(S.global.checkin, d)) { toast('今天已打卡'); return; }
  S.global.checkin.push(d); addXp(10); checkBadges(); save(); toast('打卡成功 +10 XP 🔥'); show(activeTab);
}
function applySettings() {
  document.body.classList.toggle('dark', !!S.global.settings.dark);
  const app = $('#app'); app.className = 'font-' + (S.global.settings.font || 'm');
}

/* 移动端左右滑动切题 */
function bindSwipe() {
  const pl = $('#player');
  let sx = 0, sy = 0, st = 0, dir = 0; // dir: 0 未定 / 1 横向 / -1 纵向
  const TH = 45;                        // 触发切换所需的最小水平位移
  pl.addEventListener('touchstart', e => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); dir = 0; }, { passive: true });
  pl.addEventListener('touchmove', e => {
    if (!P || $('#player').classList.contains('hidden')) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (dir === 0 && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) dir = Math.abs(dx) > Math.abs(dy) ? 1 : -1; // 先出现的方向锁定手势
    if (dir === 1) e.preventDefault();   // 横向手势：阻止浏览器纵向滚动抢走事件
  }, { passive: false });
  const finish = e => {
    if (!P || $('#player').classList.contains('hidden')) return;
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]); if (!t) return;
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (dir === 1 && Math.abs(dx) > TH && Math.abs(dy) < 90) dx < 0 ? nextQ() : prevQ(); // 左滑下一题，右滑上一题
  };
  pl.addEventListener('touchend', finish, { passive: true });
  pl.addEventListener('touchcancel', finish, { passive: true }); // 手势被浏览器取消也要兜底判定
}

/* ---------- 初始化 ---------- */
function init() {
  const sel = $('#subjectSelect');
  sel.innerHTML = Object.keys(SB).map(k => `<option value="${k}">${esc(SB[k].name)}</option>`).join('');
  sel.value = cur;
  sel.addEventListener('change', () => { cur = sel.value; closePlayer(); show(activeTab); });
  $$('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));
  document.addEventListener('click', onAct);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  bindSwipe();
  applySettings();
  show('home');
}
init();
