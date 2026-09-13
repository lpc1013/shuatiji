/**
 * 题库选项修复库（可复用）
 * 处理三类极光选项损坏：
 *  R1 题干末尾残留选项文本（如 "腋窝Ⅱ组淋巴结位于 B胸小肌外侧"，options 缺 B）→ 提取补入
 *  R2 选项值内嵌下一个选项（如 C 的值里含 "D.肿瘤细胞胞质稀少"）→ 拆分
 *  R3 选项键名跳号（{A,B,C,E}）→ 重排为连续字母，答案同步重映射
 * 另：R4 HTML 标签清洗；R5 图片题标记（选项值全为「见图」）
 */
export function normStemKey(s) {
  return String(s ?? "").replace(/<[^>]*>/g, "")
    .replace(/[，。、；：？！""''（）【】《》\.,;:?!'"()\[\]{}<>~`\-_—…·\/\\|@#$%^&*+=\s]/g, "").toLowerCase();
}

/** 清洗 HTML：只删白名单标签，避免误伤 python 代码 `<class 'int'>`、`mark<60` 等 */
const HTML_TAG = /<\/?(?:br|p|div|span|b|i|u|strong|em|sub|sup|font|table|thead|tbody|tr|td|th|ul|ol|li|img|hr|a|h[1-6]|center|small|big)\b[^>]*>/gi;
export function cleanHtml(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr)>/gi, "\n")
    .replace(/<img\b[^>]*>/gi, "[图片]")
    .replace(HTML_TAG, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * @returns {{changed:boolean, changes:Array, options:Object, stem:string, answer:string, imageMissing:boolean, needManual:boolean}}
 */
export function fixQuestion(stem, options, answer, type) {
  const changes = [];
  let opts = {}; for (const [k, v] of Object.entries(options || {})) opts[k] = String(v ?? "");
  let st = String(stem ?? "");
  const rawAns = String(answer ?? "").toUpperCase().trim().replace(/[\s.．、。:：]+$/, "");
  const letterOnlyAns = /^[A-F]+$/.test(rawAns);
  let ans = letterOnlyAns ? rawAns : "";
  let needManual = false;
  let missingOption = null;
  // 填空题 / 判断题 / 非字母答案（文本、多空、判断）不参与选项重排，只做清洗
  const skipOptionFix = Object.keys(opts).some(k => /^blank|^__/i.test(k)) || !letterOnlyAns;

  const alphaOf = o => Object.keys(o).filter(k => /^[A-Z]$/.test(k)).sort();

  // ---------- R4 HTML ----------
  const st2 = cleanHtml(st);
  if (st2 !== st && (st2.length > 0 || st.length === 0)) { changes.push({ type: "R4-stem" }); st = st2; }
  for (const k of Object.keys(opts)) {
    const v2 = cleanHtml(opts[k]);
    if (v2 !== opts[k] && (v2.trim().length > 0 || opts[k].trim().length === 0)) { opts[k] = v2; changes.push({ type: "R4-opt", detail: k }); }
  }

  // ---------- R5 图片题 ----------
  const vals = Object.keys(opts).filter(k => /^[A-Z]$/.test(k)).map(k => opts[k].replace(/\s/g, ""));
  const imageMissing = vals.length >= 3 && new Set(vals).size === 1 && /见图|如图|图\d/.test(vals[0]);

  // ---------- R6 选项值冗余前缀（{"A":"A.xxx"} → "xxx"） ----------
  for (const k of Object.keys(opts)) {
    if (!/^[A-Z]$/.test(k)) continue;
    const v = opts[k];
    // 仅剥「字母 + 分隔符（点/顿号/冒号/空白）」形态，保留 "A型行为" 这类正常内容
    const m = v.match(/^\s*([A-F])(?:\s*[.、．:：]\s*|[ \t\u3000]+)(.+)$/s);
    if (m && m[1] === k && m[2].trim().length >= 1) {
      opts[k] = m[2].trim();
      changes.push({ type: "R6", detail: k });
    }
  }

  if (!skipOptionFix) {
    // ---------- R2 选项值内嵌下一项（可多次） ----------
    for (let pass = 0; pass < 3; pass++) {
      let did = false;
      for (const k of alphaOf(opts)) {
        const v = opts[k];
        // 字母前不能是大写字母或点号（排除 "ESR、RF、" 与 "BurnetM.F."）；允许中文，如 "保守治疗C. 长期卧床"
        const re = /(?<![A-Z.．])([A-F])[.、．]\s*([^A-F]{2,150})\s*$/;
        const m = v.match(re);
        if (m && m[1] > k && !opts[m[1]] && k !== m[1]) {
          const head = v.slice(0, m.index).replace(/[\s,，、;；:：]+$/, "");
          if (head.length >= 1) {
            opts[k] = head;
            opts[m[1]] = m[2].trim();
            changes.push({ type: "R2", detail: `从 ${k} 拆出 ${m[1]}` });
            did = true;
          }
        }
      }
      if (!did) break;
    }

    // ---------- R1 题干残留补项 ----------
    const alpha0 = alphaOf(opts);
    const ansMax = (ans.match(/[A-F]/g) || []).sort().pop() || "A";
    const topLetter = [alpha0[alpha0.length - 1] || "A", ansMax].sort().pop();
    const expected = [];
    for (let c = 65; c <= topLetter.charCodeAt(0); c++) expected.push(String.fromCharCode(c));
    const missing = expected.filter(l => !alpha0.includes(l));

    const pulled = {};
    if (missing.length) {
      let rest = st;
      for (let guard = 0; guard < 5; guard++) {
        rest = rest.replace(/[\s\u3000]+$/, "");
        const win = rest.slice(-300);
        const m = win.match(/([A-F])([^A-F]{1,300})$/);
        if (!m) break;
        const idx = rest.length - win.length + m.index;
        if (!missing.includes(m[1]) || pulled[m[1]]) break;
        const txt = m[2].replace(/^[\s.、．:：)）\]]+/, "").trim();
        if (txt.length < 1) break;
        pulled[m[1]] = txt;
        rest = rest.slice(0, idx).replace(/[\s，。、；;:：]+$/, "");
      }
      if (Object.keys(pulled).length) {
        for (const [l, t] of Object.entries(pulled)) opts[l] = t;
        st = rest;
        changes.push({ type: "R1", detail: JSON.stringify(pulled).slice(0, 120) });
        // 提取不全 → 仍需人工
        if (missing.some(l => !pulled[l])) {
          needManual = true;
          changes.push({ type: "R1-partial", detail: `仍缺 ${missing.filter(l => !pulled[l]).join("")}` });
        }
      } else {
        // R1b：题干尾部「空格分隔的独立片段」= 被删选项内容（无字母前缀形态）
        //   例："…相关因素 遗传因素" → 补 A=遗传因素；"…检查是 复查尿常规 尿沉渣涂片检查 尿白蛋白/肌酐比值" → 补 ABC
        const toks = []; const re2 = /[^\s\u3000]+/g; let mm;
        while ((mm = re2.exec(st))) toks.push({ text: mm[0], start: mm.index });
        const picked = [];
        if (toks.length >= 2) {
          // ⚠️ 必须「凑够 missing 个数就停」：早先写成固定扫 4 个 token，
          //    会把题干正文（如"…的相关因素"）也当成选项吃掉，导致 picked.length ≠ missing.length 而整条 R1b 失效
          for (let i = toks.length - 1; i >= 0 && picked.length < missing.length; i--) {
            const t = toks[i].text;
            if (t.length < 2 || t.length > 60) break;
            if (/[?？]$|(?:是|为|的|有|包括|哪项|什么|哪些)$/.test(t)) break;
            if (/[，。；：，、]|[【】（）()]/.test(t)) break;   // 含标点/括号的片段不是选项
            picked.unshift(toks[i]);
          }
        }
        let ok = false;
        if (picked.length === missing.length && picked.length > 0) {
          const sortedMissing = [...missing].sort();
          sortedMissing.forEach((l, i) => { pulled[l] = picked[i].text; });
          for (const [l, t] of Object.entries(pulled)) opts[l] = t;
          st = st.slice(0, picked[0].start).replace(/[\s，。、；;:：]+$/, "");
          changes.push({ type: "R1b", detail: JSON.stringify(pulled).slice(0, 120) });
          ok = true;
        }
        if (!ok) {
          // 原题本身就少一项（题干无残留）→ 软标记，交由 R3 重排键名即可，不算人工
          missingOption = missing;
          changes.push({ type: "R1-missing", detail: `原题可能缺 ${missing.join("")} 选项（无残留文本），已按现有项重排` });
        }
      }
    }
  }

  // ⚠️ 源头题干本身就只有残留选项（如极光_传染病(test) 那条 stem 字面就是 "A. 普通登革热"）：
  //    R1 会把整条题干吃掉。此时选项补全了但题干没了 —— 必须显式标记，不能静默丢信息。
  if (!st.trim()) {
    needManual = true;
    changes.push({ type: "R1-stemLost", detail: "源数据题干即只有残留选项，修复后题干为空" });
  }

  // ---------- R3 键名重排（非 A-Z 键原样保留，如填空题 blank_1） ----------
  const newOpts = {}; const map = {};
  const alphaKeys = alphaOf(opts);
  alphaKeys.forEach((l, i) => { const nl = String.fromCharCode(65 + i); map[l] = nl; newOpts[nl] = opts[l]; });
  for (const k of Object.keys(opts)) if (!/^[A-Z]$/.test(k)) newOpts[k] = opts[k];
  if (!skipOptionFix && alphaKeys.some((l, i) => l !== String.fromCharCode(65 + i)))
    changes.push({ type: "R3", detail: alphaKeys.join("") + "→" + alphaKeys.map((_, i) => String.fromCharCode(65 + i)).join("") });
  const newAns = ans.replace(/[A-F]/g, c => map[c] || c);

  // 校验
  const finalKeys = Object.keys(newOpts).filter(k => /^[A-Z]$/.test(k));
  const ansBad = !!newAns && [...newAns].some(c => !finalKeys.includes(c));
  const gapsLeft = finalKeys.some((l, i) => l !== String.fromCharCode(65 + i));
  if (ansBad || (gapsLeft && finalKeys.length > 1)) needManual = true;

  return {
    changed: changes.length > 0,
    changes, options: newOpts, stem: st, answer: newAns || rawAns,
    imageMissing, needManual, missingOption,
    answerBefore: rawAns, answerOOB: ansBad
  };
}
