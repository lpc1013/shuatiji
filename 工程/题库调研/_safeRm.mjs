import fs from 'fs';

/**
 * 安全递归删除（同步版），供 build_dist / build_site_data / _sync_dist 复用。
 * 移植自 build_packs.mjs:214-224 已验证模式：异步 rm + 重试 + rename 挪 trash 兜底。
 *
 * 为什么不用裸 fs.rmSync(recursive)：本机在大规模递归删/写上会 native fast-fail
 * 0xC0000409，且 Defender/索引锁可能导致「只删掉一部分」残留而不报错（曾导致整科缺失）。
 * 这里用「重试 + rename 挪走再删」规避。
 *
 * 既删目录也可删单个文件（rmSync recursive+force 对文件同样安全）。
 */
function sleepSync(ms) {
  try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms); } catch { /* 退化：忽略睡眠 */ }
}

export function safeRmSync(target) {
  if (!target || !fs.existsSync(target)) return true;
  // 1) 直接递归删，重试 5 次（应对瞬时锁）
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 重试 */ }
    if (!fs.existsSync(target)) return true;
    sleepSync(300);
  }
  if (!fs.existsSync(target)) return true;
  // 2) 兜底：rename 挪到 trash（rename 不删文件，通常能成），再彻底删
  try {
    const trash = target + '_trash_' + Date.now();
    fs.renameSync(target, trash);
    try { fs.rmSync(trash, { recursive: true, force: true }); } catch { /* 留着，下次再删 */ }
    if (!fs.existsSync(target)) return true;
  } catch { /* 继续 */ }
  // 3) 再试一次直接删
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 重试 */ }
    if (!fs.existsSync(target)) return true;
    sleepSync(300);
  }
  return !fs.existsSync(target);
}

export default safeRmSync;
