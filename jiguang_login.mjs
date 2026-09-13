// 极光题库登录 (多账号 -> JWT 池)
// 多账号: node jiguang_login.mjs <creds.json>   creds.json=[{phone,password},...] 用完即删, 不留存账密
// 单账号(旧): node jiguang_login.mjs <手机号> [密码]   写入 jiguang_token.txt
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKF = path.join(HERE, 'jiguang_token.txt');
const POOLF = path.join(HERE, 'jiguang_tokens.txt');

function extractToken(j) {
  // 已知结构: j.data.access_token ; 也兜底递归找 JWT
  if (j?.data?.access_token) return j.data.access_token;
  const find = (o, seen = new Set()) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return null; seen.add(o);
    if (typeof o === 'string') { const s = o.trim(); return (s.startsWith('eyJ') && s.split('.').length === 3) ? s : null; }
    for (const v of Object.values(o)) { const r = find(v, seen); if (r) return r; }
    return null;
  };
  return find(j);
}

async function loginOne(phone, pwd) {
  const r = await fetch('https://api.ji-guang.top/api/v1/user/auth/login-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password: pwd })
  });
  const j = await r.json();
  const tok = extractToken(j);
  return { status: r.status, tok, info: j };
}

// ---- 多账号模式 ----
const arg = process.argv[2];
if (arg && arg.endsWith('.json')) {
  let creds;
  try { creds = JSON.parse(fs.readFileSync(arg, 'utf8')); } catch (e) { console.error('读取账密文件失败:', e.message); process.exit(1); }
  if (!Array.isArray(creds)) creds = [creds];
  const tokens = [];
  for (const c of creds) {
    const phone = String(c.phone || '').trim();
    const pwd = String(c.password || '');
    if (!phone || !pwd) { console.error('  跳过空账密条目'); continue; }
    process.stdout.write(`  登录 ${phone} ... `);
    try {
      const { status, tok, info } = await loginOne(phone, pwd);
      if (!tok) { console.log(`失败 (HTTP ${status}) ` + (info?.message || JSON.stringify(info).slice(0, 120))); continue; }
      tokens.push(tok);
      console.log(`OK (token ${tok.length} 字符)`);
    } catch (e) { console.log('异常: ' + e.message); }
  }
  if (!tokens.length) { console.error('无可用 token, 未写入'); process.exit(2); }
  fs.writeFileSync(POOLF, tokens.join('\n') + '\n', 'utf8');
  fs.writeFileSync(TOKF, tokens[0], 'utf8'); // 兼容旧逻辑
  console.log(`✅ 已写入 ${tokens.length} 个 token -> ${POOLF}`);
  process.exit(0);
}

// ---- 单账号模式(旧) ----
const phone = arg;
const pwd = process.argv[3] || phone;
if (!phone) { console.error('用法: node jiguang_login.mjs <creds.json|手机号> [密码]'); process.exit(1); }
const { status, tok, info } = await loginOne(phone, pwd);
if (tok) {
  if (fs.existsSync(TOKF)) {
    fs.copyFileSync(TOKF, TOKF.replace(/\.txt$/, '.bak_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.txt'));
    console.log('旧 token 已备份');
  }
  fs.writeFileSync(TOKF, tok);
  console.log('✅ 登录成功, token 已写入 jiguang_token.txt');
  const d = info?.data;
  console.log('  用户:', d?.user?.nickname || d?.user?.phone || '(未知)', '| VIP:', d?.user?.is_vip ?? '?', '| 有效期:', d?.expires_in ?? '?');
} else {
  console.log('❌ 登录失败 HTTP', status, JSON.stringify(info).slice(0, 300));
  process.exit(1);
}
