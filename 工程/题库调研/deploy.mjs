#!/usr/bin/env node
/**
 * 发布打包单一真源（合并原 build_dist.mjs 与 _sync_dist.mjs）。
 *
 *   node deploy.mjs          增量同步（copyFileSafe 逐文件 + 重试 + safeRm 清残留，本机稳）
 *   node deploy.mjs --full   整目录重建（safeRm 清场 + copy + 泄漏扫描）
 *
 * 兼容入口（保留原调用方式，逻辑只此一份）：
 *   build_dist.mjs  → main('full')
 *   _sync_dist.mjs  → main('inc')
 *
 * 设计要点：
 * - 绝不裸用 fs.rmSync(recursive)：清场走 _safeRm.mjs 的 safeRmSync（重试 + rename 挪 trash）。
 * - 复制走 copyFileSafe（逐文件 + 重试，应对 Defender/索引锁），比原 build_dist 的纯 copyFileSync 更稳。
 * - 白名单单一真源在 _whitelist.mjs（FILES/DIRS/黑名单），三处共享，防漂移。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { safeRmSync } from './_safeRm.mjs';
import { FILES, DIRS, DENY_TOP, DENY_ANY } from './_whitelist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'site_dist');
const nfkc = s => String(s).normalize('NFKC');   // 防 fullwidth 文件名绕过

function sleepSync(ms) {
  try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms); } catch { }
}

/* 逐文件复制 + 重试（最多 6 次，退避 120ms*i）。失败返回 false 不抛，由调用方汇总。 */
function copyFileSafe(s, d) {
  for (let i = 0; i < 6; i++) {
    try { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); return true; }
    catch (e) {
      if (i === 5) { console.error('COPY FAIL ' + s + ' -> ' + d + ' : ' + e.message); return false; }
      sleepSync(120 * (i + 1));
    }
  }
  return false;
}

/* 递归复制（栈遍历，跳过符号链接等非常规条目；DENY_ANY 漏扫兜底不进发布）。 */
function copyTreeSafe(src, dst) {
  let n = 0, fail = 0;
  const stack = [['', src]];
  while (stack.length) {
    const [rel, cur] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (e) { console.error('READDIR FAIL ' + cur + ' : ' + e.message); fail++; continue; }   // F02：读目录失败计入 fail，不再静默
    for (const e of ents) {
      if (e.isDirectory()) stack.push([path.join(rel, e.name), path.join(cur, e.name)]);
      else if (e.isFile()) {
        if (DENY_ANY.test(e.name) || DENY_ANY.test(nfkc(rel))) continue;   // 漏扫兜底，不进发布
        const s = path.join(cur, e.name), d = path.join(dst, rel, e.name);
        if (copyFileSafe(s, d)) n++; else fail++;
      } else console.error('SKIP 非常规条目: ' + path.join(cur, e.name));
    }
  }
  return { n, fail };
}

/* 删除 dist 中「白名单外/敏感」残留（用 safeRmSync，非裸 rmSync）。F02：删除失败计入 fail 上抛。 */
function removeStale() {
  let removed = 0, fail = 0;
  for (const name of fs.readdirSync(DIST)) {
    const fp = path.join(DIST, name);
    const isWhite = FILES.includes(name) || DIRS.includes(name);
    if (!isWhite || DENY_TOP.test(name)) { if (safeRmSync(fp)) removed++; else { console.error('RMTOP FAIL ' + fp); fail++; } }
  }
  (function scan(p) {
    let ents;
    try { ents = fs.readdirSync(p, { withFileTypes: true }); }
    catch (e) { console.error('READDIR FAIL ' + p + ' : ' + e.message); fail++; return; }
    for (const e of ents) {
      const fp = path.join(p, e.name);
      const rel = path.relative(DIST, fp);
      if (DENY_ANY.test(e.name) || DENY_ANY.test(nfkc(rel))) { if (safeRmSync(fp)) removed++; else { console.error('RM FAIL ' + fp); fail++; } continue; }
      if (e.isDirectory()) scan(fp);
    }
  })(DIST);
  return { removed, fail };
}

function main(mode) {
  const full = mode === 'full';
  // 必备文件/目录校验
  const errs = [];
  for (const f of FILES) if (!fs.existsSync(path.join(SRC, f))) errs.push('缺失必需文件: site/' + f);
  for (const d of DIRS) if (!fs.existsSync(path.join(SRC, d))) errs.push('缺失必需目录: site/' + d);
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }

  if (full) {
    console.log('[deploy --full] 清场 + 整目录重建 site_dist');
    if (!safeRmSync(DIST)) {   // F02：清场失败即中止，保留旧产物
      console.error('FAIL: safeRmSync(DIST) 失败，中止整目录重建（旧产物保留）');
      process.exit(1);
    }
    fs.mkdirSync(DIST, { recursive: true });
    let n = 0, fail = 0;
    for (const f of FILES) { if (copyFileSafe(path.join(SRC, f), path.join(DIST, f))) n++; else fail++; }
    for (const d of DIRS) { const r = copyTreeSafe(path.join(SRC, d), path.join(DIST, d)); n += r.n; fail += r.fail; }
    console.log(`[deploy --full] 白名单复制 ${n} 文件（失败 ${fail}）`);
    if (fail > 0) {   // F02：复制失败必须非零退出，防止上层自动化把缺文件当成功
      console.error(`FAIL: ${fail} 个文件复制失败，site_dist 不完整（见上方 COPY FAIL 行）`);
      process.exit(1);
    }

    // 泄漏扫描（整目录重建后，确认没有非白名单/敏感文件混入）
    const top = fs.readdirSync(DIST);
    const unexpected = top.filter(x => !FILES.includes(x) && !DIRS.includes(x));
    const denied = top.filter(x => DENY_TOP.test(x));
    let cnt = 0, bytes = 0;
    (function walk(p) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp); else { cnt++; bytes += fs.statSync(fp).size; }
      }
    })(DIST);
    const leaks = [];
    (function scan(p) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        const rel = path.relative(DIST, fp);
        if (DENY_ANY.test(e.name) || DENY_ANY.test(nfkc(rel))) leaks.push(rel);
        if (e.isDirectory()) scan(fp);
      }
    })(DIST);
    const rep = { dist: DIST, mode: 'full', files: cnt, MB: +(bytes / 1048576).toFixed(2), top, unexpected, denied, leaks };
    console.log(JSON.stringify(rep, null, 2));
    if (unexpected.length || denied.length || leaks.length) {
      console.error('FAIL: 发布目录出现非白名单 / 敏感文件');
      process.exit(1);
    }
    console.log('OK  site_dist 就绪（整目录重建）→ 部署请指向 ' + DIST);
  } else {
    console.log('[deploy] 增量同步 site → site_dist');
    let n = 0, fail = 0;
    for (const f of FILES) {
      if (!fs.existsSync(path.join(SRC, f))) { console.error('缺失 ' + f); continue; }
      if (copyFileSafe(path.join(SRC, f), path.join(DIST, f))) n++; else fail++;
    }
    for (const d of DIRS) {
      if (!fs.existsSync(path.join(SRC, d))) { console.error('缺失目录 ' + d); continue; }
      const r = copyTreeSafe(path.join(SRC, d), path.join(DIST, d));
      n += r.n; fail += r.fail;
    }
    const removed = removeStale();
    const out = { mode: 'inc', copied: n, failed: fail, removedStale: removed.removed, rmFail: removed.fail, dist: DIST };
    console.log(JSON.stringify(out));
    fs.writeFileSync(path.join(ROOT, '工程', '题库调研', '_sync_result.json'), JSON.stringify(out, null, 2), 'utf8');
    if (fail > 0 || removed.fail > 0) {   // F02：任何复制/删除失败 → 非零退出
      console.error(`FAIL: 复制失败 ${fail} / 残留清理失败 ${removed.fail}，同步未完成`);
      process.exit(1);
    }
  }
}

// 仅在直接运行时执行；被 build_dist.mjs / _sync_dist.mjs import 时不触发
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.includes('--full') ? 'full' : 'inc');
}

export { main };
export default main;
