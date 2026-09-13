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

// ---------- AI 出题（TokenHub 代理，4 模型轮询，仅 lql 可调用） ----------
let TOKENHUB_CFG = null;
function loadTokenHub() {
  if (TOKENHUB_CFG) return TOKENHUB_CFG;
  const cfg = {
    base: process.env.TOKENHUB_BASE || "https://tokenhub.tencentmaas.com/v1",
    keys: {
      "hy-mt2-plus": process.env.KEY_HY_MT2_PLUS,
      "hy-mt2-lite": process.env.KEY_HY_MT2_LITE,
      "hunyuan-role-latest": process.env.KEY_HUNYUAN_ROLE_LATEST,
      "hy-role": process.env.KEY_HY_ROLE,
    },
  };
  // 允许从同目录 config.json 读取私钥（不入库；优先级低于环境变量）
  try {
    const p = path.join(__dirname, "config.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (c.base) cfg.base = c.base;
      if (c.keys) for (const k in c.keys) if (c.keys[k]) cfg.keys[k] = c.keys[k];
    }
  } catch (e) {}
  TOKENHUB_CFG = cfg;
  return cfg;
}

function postJSON(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(bodyObj);
    const req = https.request(
      u,
      {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          headers || {}
        ),
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

let modelCursor = 0;
async function aiGen(auth, payload) {
  const t = await authUser(auth);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  if (t.username !== "lql") return { ok: false, msg: "无权限：仅 lql 账号可调用 AI 出题" };
  const q = payload.question;
  if (!q || !q.content || !q.options) return { ok: false, msg: "缺少题目内容" };
  const cfg = loadTokenHub();
  const avail = Object.keys(cfg.keys).filter((k) => !!cfg.keys[k]);
  if (!avail.length) return { ok: false, msg: "未配置任何模型 Key" };

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
    const model = avail[modelCursor % avail.length];
    modelCursor++;
    let obj;
    try {
      const up = await postJSON(
        cfg.base + "/chat/completions",
        { Authorization: "Bearer " + cfg.keys[model] },
        {
          model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          temperature: 0.85,
          max_tokens: 1200,
        }
      );
      if (up.status < 200 || up.status >= 300) {
        return { ok: false, msg: `模型 ${model} 调用失败(${up.status})：${up.body.slice(0, 200)}` };
      }
      const j = JSON.parse(up.body);
      let content =
        (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      try {
        obj = JSON.parse(content);
      } catch (e) {
        const a = content.indexOf("{");
        const b = content.lastIndexOf("}");
        if (a >= 0 && b > a) obj = JSON.parse(content.slice(a, b + 1));
        else return { ok: false, msg: "模型返回非 JSON：" + content.slice(0, 120) };
      }
      if (typeof obj.options !== "object" || !obj.options) {
        return { ok: false, msg: "模型返回缺少 options" };
      }
      obj.model = model;
      obj.correct = (obj.correct || "").toString().toUpperCase();
      obj.multi = !!obj.multi;
      questions.push(obj);
    } catch (e) {
      return { ok: false, msg: "生成出错：" + (e.message || e) };
    }
  }
  return { ok: true, questions };
}

async function aiExplain(auth, payload) {
  const t = await authUser(auth);
  if (!t) return { ok: false, msg: "未登录或登录已过期" };
  if (t.username !== "lql") return { ok: false, msg: "无权限：仅 lql 账号可调用 AI 解析" };
  const q = payload.question;
  if (!q || !q.content || !q.options) return { ok: false, msg: "缺少题目内容" };
  const cfg = loadTokenHub();
  const avail = Object.keys(cfg.keys).filter((k) => !!cfg.keys[k]);
  if (!avail.length) return { ok: false, msg: "未配置任何模型 Key" };

  const multi = !!q.multi;
  const optText = Object.keys(q.options).map((k) => k + ". " + q.options[k]).join("\n");
  const sys = "你是一名医学考试辅导老师，只输出严格 JSON 对象，不要任何额外文字或 markdown 代码块。";
  const userPrompt = `请解析下面这道题（题目可能有争议、原解析可能有误，请基于医学知识独立判断并给出严谨解析）。
要求：
- 一句话考点总结 summary。
- 核心要点 keyPoint（1-2 句）。
- 逐项分析 items：每个选项标注 isCorrect（true/false）并给 why（解析）。
- 常见陷阱 commonTrap（1-2 句，可空串）。
- 只输出 JSON，格式：{"summary":"...","keyPoint":"...","items":[{"option":"A","isCorrect":true,"why":"..."}],"commonTrap":""}
题目：
科目：${payload.subject || "医学"}
题干：${q.content}
选项：
${optText}
标注正确答案：${q.correct}
${q.explanation ? "题面自带解析：" + q.explanation : ""}
${payload.userAnswer ? "用户作答：" + payload.userAnswer : ""}`;

  const model = avail[modelCursor % avail.length];
  modelCursor++;
  try {
    const up = await postJSON(
      cfg.base + "/chat/completions",
      { Authorization: "Bearer " + cfg.keys[model] },
      {
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        temperature: 0.4,
        max_tokens: 1400,
      }
    );
    if (up.status < 200 || up.status >= 300) {
      return { ok: false, msg: `模型 ${model} 调用失败(${up.status})：${up.body.slice(0, 200)}` };
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
      else return { ok: false, msg: "模型返回非 JSON：" + content.slice(0, 120) };
    }
    obj.model = model;
    if (!Array.isArray(obj.items)) obj.items = [];
    return { ok: true, result: obj };
  } catch (e) {
    return { ok: false, msg: "解析出错：" + (e.message || e) };
  }
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
