const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cloudbase = require("@cloudbase/node-sdk");

const ENV = "shuatiji-d9gm0j668e9396859";
const app = cloudbase.init({ env: ENV });
const db = app.database();

const COL = { users: "users", progress: "progress", tokens: "tokens", eng_progress: "eng_progress" };
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 60; // 60 天

let colsReady = false;
async function ensureCols() {
  if (colsReady) return;
  for (const name of Object.values(COL)) {
    try {
      await db.createCollection(name);
    } catch (e) {
      // 已存在则忽略
    }
  }
  colsReady = true;
}

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

async function register(username, password) {
  username = (username || "").trim();
  if (!username || !password) return { ok: false, msg: "用户名和密码必填" };
  if (username.length < 2) return { ok: false, msg: "用户名至少 2 个字符" };
  if (password.length < 6) return { ok: false, msg: "密码至少 6 位" };
  const exist = await db.collection(COL.users).where({ username }).get();
  if (exist.data && exist.data.length) return { ok: false, msg: "用户名已存在" };
  const salt = newSalt();
  const verifier = hashPassword(password, salt);
  const r = await db.collection(COL.users).add({
    username,
    salt,
    verifier,
    createdAt: Date.now(),
  });
  return { ok: true, uid: r.id };
}

async function login(username, password) {
  username = (username || "").trim();
  const res = await db.collection(COL.users).where({ username }).get();
  const u = res.data && res.data[0];
  if (!u) return { ok: false, msg: "用户不存在" };
  if (hashPassword(password, u.salt) !== u.verifier) {
    return { ok: false, msg: "密码错误" };
  }
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await db.collection(COL.tokens).add({
    token,
    uid: u._id,
    username: u.username,
    createdAt: now,
    expires: now + TOKEN_TTL,
  });
  return { ok: true, token, username: u.username, uid: u._id };
}

async function authUser(token) {
  if (!token) return null;
  const res = await db.collection(COL.tokens)
    .where({ token, expires: db.command.gt(Date.now()) })
    .get();
  return res.data && res.data[0] ? res.data[0] : null;
}

async function pull(token) {
  const t = await authUser(token);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  const res = await db.collection(COL.progress).where({ _id: t.uid }).get();
  const doc = res.data && res.data[0];
  return {
    ok: true,
    username: t.username,
    hasData: !!doc,
    state: doc && doc.state ? doc.state : null,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null,
  };
}

async function push(token, state, updatedAt) {
  const t = await authUser(token);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  if (state === undefined || state === null) return { ok: false, msg: "无数据" };
  await db.collection(COL.progress).doc(t.uid).set({
    uid: t.uid,
    username: t.username,
    state,
    updatedAt: updatedAt || Date.now(),
  });
  return { ok: true };
}

// ---------- 英语单词进度（独立集合，按词 last-write-wins，与整包 state 解耦） ----------
/* 合并规则：逐词取「标记次数 n 大者」赢（n 多=信息更全），n 相等取时间戳 t 新者；
 * log 做去重拼接、按时间排序、封顶 50。整条赢（含 s/due），不做 log 级缝合，
 * 避免两端 log 指向不同 s 状态导致「进度回放矛盾」。 */
function mergeEnglishWords(cur, inc) {
  const out = Object.assign({}, cur);
  for (const k of Object.keys(inc || {})) {
    const a = out[k], b = inc[k];
    if (!a) { out[k] = b; continue; }
    const na = a.n || 0, nb = b.n || 0;
    const winner = (nb > na || (nb === na && (b.t || 0) > (a.t || 0))) ? b : a;
    const seen = new Set(), uniq = [];
    for (const e of [].concat(a.log || [], b.log || [])) {
      const key = (e && e[0]) + "@" + (e && e[1]);
      if (!seen.has(key)) { seen.add(key); uniq.push(e); }
    }
    uniq.sort((x, y) => (x[1] || 0) - (y[1] || 0));
    winner.log = uniq.slice(-50);
    out[k] = winner;
  }
  return out;
}

async function englishPush(token, words, clientTs) {
  const t = await authUser(token);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  if (!words || typeof words !== "object") return { ok: false, msg: "无数据" };
  const ref = db.collection(COL.eng_progress);
  const doc = await ref.where({ _id: t.uid }).get();
  const cur = (doc.data && doc.data[0] && doc.data[0].words) || {};
  const merged = mergeEnglishWords(cur, words);
  await ref.doc(t.uid).set({ uid: t.uid, username: t.username, words: merged, updatedAt: Date.now() });
  return { ok: true, serverTs: Date.now(), count: Object.keys(merged).length };
}
async function englishPull(token) {
  const t = await authUser(token);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  const doc = await db.collection(COL.eng_progress).where({ _id: t.uid }).get();
  const d = doc.data && doc.data[0];
  return { ok: true, words: (d && d.words) || {}, serverTs: (d && d.updatedAt) || 0 };
}
async function englishReset(token) {
  const t = await authUser(token);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  await db.collection(COL.eng_progress).doc(t.uid).remove().catch(() => {});
  return { ok: true };
}

// ---------- AI 出题（多渠道 Key 池，OpenAI 兼容，仅 lql 可调用） ----------
// 每通道自带 base + model + key；环境变量提供混元通道，config.json 提供新增通道（不入库）
let AI_CFG = null;
function loadAI() {
  if (AI_CFG) return AI_CFG;
  const channels = [];
  const push = (base, model, key, name) => {
    if (key) channels.push({ base, model, key, name: name || model });
  };

  // 1) 既有 TokenHub / 混元通道（环境变量）
  const tbBase = process.env.TOKENHUB_BASE || "https://tokenhub.tencentmaas.com/v1";
  push(tbBase, "hy-mt2-plus", process.env.KEY_HY_MT2_PLUS);
  push(tbBase, "hy-mt2-lite", process.env.KEY_HY_MT2_LITE);
  push(tbBase, "hunyuan-role-latest", process.env.KEY_HUNYUAN_ROLE_LATEST);
  push(tbBase, "hy-role", process.env.KEY_HY_ROLE);

  // 2) 同目录 config.json（不入库，存放私钥与新增通道；channels 数组优先）
  try {
    const p = path.join(__dirname, "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(c.channels)) {
        for (const ch of c.channels) {
          if (ch && ch.key) push(ch.base || tbBase, ch.model, ch.key, ch.name);
        }
      } else if (c.keys) {
        const lb = c.base || tbBase;
        for (const k in c.keys) if (c.keys[k]) push(lb, k, c.keys[k]);
      }
    }
  } catch (e) {}

  AI_CFG = { channels };
  return AI_CFG;
}

// 每次调用随机打乱通道顺序：从随机通道开始出题，命中失败（非 2xx 或异常）自动换下一个随机通道重试（多 key 冗余 / 限流兜底）
function shuffleChan(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function callModel(sys, userPrompt, temperature, max_tokens) {
  const chs = shuffleChan(loadAI().channels.filter((c) => !!c.key));
  if (!chs.length) return { err: "未配置任何模型 Key" };
  /* 全局时间预算：函数本身 60s 超时（SCF Timeout=60，超时直接杀进程不返回响应，
     浏览器端表现为 TypeError: Failed to fetch）。模型调用总预算 45s，
     剩余时间留给 DB 鉴权与响应传输；单个通道超时取「20s 与剩余预算」较小者。 */
  const deadline = Date.now() + 45000;
  let lastErr = "";
  for (const ch of chs) {
    const remain = deadline - Date.now();
    if (remain <= 2000) break;   // 预算耗尽，不再尝试下一通道
    try {
      const up = await postJSON(
        ch.base + "/chat/completions",
        { Authorization: "Bearer " + ch.key },
        {
          model: ch.model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          temperature,
          max_tokens,
        },
        Math.min(20000, remain - 1000)
      );
      if (up.status < 200 || up.status >= 300) {
        lastErr = `模型 ${ch.model} 调用失败(${up.status})：${up.body.slice(0, 200)}`;
        continue;
      }
      const j = JSON.parse(up.body);
      let content =
        (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      let obj;
      try {
        obj = JSON.parse(content);
      } catch (e) {
        const a = content.indexOf("{");
        const b = content.lastIndexOf("}");
        if (a >= 0 && b > a) obj = JSON.parse(content.slice(a, b + 1));
        else {
          lastErr = "模型返回非 JSON：" + content.slice(0, 120);
          continue;
        }
      }
      obj.model = ch.model;
      return { ok: true, obj };
    } catch (e) {
      lastErr = "调用出错：" + (e.message || e);
      continue;
    }
  }
  return { err: lastErr || "所有通道均失败" };
}

function postJSON(url, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const data = JSON.stringify(bodyObj);
    const req = lib.request(
      u,
      {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          headers || {}
        ),
        timeout: timeoutMs || 20000,   // 连接/空闲超时：防止单个模型通道挂起拖死整个请求（云托管网关会掐断连接 → 前端表现为 TypeError: Failed to fetch）
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("模型通道 " + (timeoutMs || 20000) / 1000 + "s 超时"));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function aiGen(auth, payload) {
  const t = await authUser(auth);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  if (t.username !== "lql") return { ok: false, msg: "无权限：仅 lql 账号可调用 AI 出题" };
  const q = payload.question;
  if (!q || !q.content || !q.options) return { ok: false, msg: "缺少题目内容" };
  const chs = loadAI().channels.filter((c) => !!c.key);
  if (!chs.length) return { ok: false, msg: "未配置任何模型 Key" };

  const multi = !!q.multi;
  const optText = Object.keys(q.options)
    .map((k) => k + ". " + q.options[k])
    .join("\n");
  const sys =
    "你是一名医学考试出题专家，只输出严格 JSON 对象，不要任何额外文字或 markdown 代码块。";
  const userPrompt = `基于下面这道题，生成 1 道考查【同一核心知识点】但题干与选项不同的变式题（不要照抄原题干）。
要求：
- 题型与原题一致（${multi ? "多选题，正确答案可为多个字母组合" : "单选题，正确答案只有一个字母"}）。
- 4 个选项（A-D）。
- 附简短解析（2-4 句）。
- 只输出 JSON，格式：{"content":"题干","options":{"A":"...","B":"...","C":"...","D":"..."},"correct":"${multi ? "如 ABC" : "A"}","multi":${multi},"explanation":"..."}
题目：
科目：${payload.subject || "医学"}
题干：${q.content}
选项：
${optText}
正确答案：${q.correct}`;

  const questions = [];
  for (let i = 0; i < 3; i++) {
    const r = await callModel(sys, userPrompt, 0.85, 1200);
    if (r.err) return { ok: false, msg: "生成出错：" + r.err };
    const obj = r.obj;
    if (typeof obj.options !== "object" || !obj.options) {
      return { ok: false, msg: "模型返回缺少 options" };
    }
    obj.correct = (obj.correct || "").toString().toUpperCase();
    obj.multi = !!obj.multi;
    questions.push(obj);
  }
  return { ok: true, questions };
}

async function aiExplain(auth, payload) {
  const t = await authUser(auth);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  if (t.username !== "lql") return { ok: false, msg: "无权限：仅 lql 账号可调用 AI 解析" };
  const q = payload.question;
  if (!q || !q.content || !q.options) return { ok: false, msg: "缺少题目内容" };
  const chs = loadAI().channels.filter((c) => !!c.key);
  if (!chs.length) return { ok: false, msg: "未配置任何模型 Key" };

  const multi = !!q.multi;
  const optText = Object.keys(q.options).map((k) => k + ". " + q.options[k]).join("\n");
  const sys = "你是一名医学考试辅导老师，只输出严格 JSON 对象，不要任何额外文字或 markdown 代码块。";
  /* ⚠️ 刻意不把原解析（q.explanation）与原答案（q.correct）发给模型：
     喂了会被锚定成复述，「AI再解析」就失去独立判断的意义（2026-10-09 用户两次要求）。
     再解析的典型场景是对答案有异议 → 模型须独立给出自己的新答案 answer，
     前端把「AI 答案 vs 原答案」并列标注、不一致时高亮。 */
  const userPrompt = `请解答下面这道题。请完全基于你自己的医学知识独立判断正确答案，不要迎合任何预设结论。
要求：
- answer：你独立判定的正确答案（单选一个字母；多选按字母序拼接，如 "ABD"）。
- summary：一句话考点总结。
- keyPoint：核心要点（1-2 句）。
- items：逐项分析，每个选项标注 isCorrect（true/false）并给 why（解析）。
- commonTrap：常见陷阱（1-2 句，可空串）。
- 只输出 JSON，格式：{"answer":"A","summary":"...","keyPoint":"...","items":[{"option":"A","isCorrect":true,"why":"..."}],"commonTrap":""}
题目：
科目：${payload.subject || "医学"}
题干：${q.content}
选项：
${optText}
${multi ? "注意：本题为多选题，answer 为多个字母。" : "注意：本题为单选题，answer 为一个字母。"}`;

  const r = await callModel(sys, userPrompt, 0.4, 1400);
  if (r.err) return { ok: false, msg: "解析出错：" + r.err };
  const obj = r.obj;
  if (!Array.isArray(obj.items)) obj.items = [];
  return { ok: true, result: obj };
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || "*";
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Quiz-Token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    return res.end();
  }
  if (req.method === "GET") {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ ok: true, svc: "quiz" }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      await ensureCols();
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch (e) {
        payload = {};
      }
      const auth =
        req.headers["x-quiz-token"] ||
        (req.headers["authorization"] &&
          req.headers["authorization"].replace(/^Bearer\s+/i, "")) ||
        payload.token ||
        "";
      const { action } = payload;
      let result;
      if (action === "register")
        result = await register(payload.username, payload.password);
      else if (action === "login")
        result = await login(payload.username, payload.password);
      else if (action === "pull") result = await pull(auth);
      else if (action === "push") result = await push(auth, payload.state, payload.updatedAt);
      else if (action === "ai-gen") result = await aiGen(auth, payload);
      else if (action === "ai-explain") result = await aiExplain(auth, payload);
      else if (action === "english-push") result = await englishPush(auth, payload.words, payload.clientTs);
      else if (action === "english-pull") result = await englishPull(auth);
      else if (action === "english-reset") result = await englishReset(auth);
      else result = { ok: false, msg: "未知操作" };
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, headers);
      res.end(JSON.stringify({ ok: false, msg: "服务器错误: " + e.message }));
    }
  });
});

server.listen(process.env.PORT || 9000);
