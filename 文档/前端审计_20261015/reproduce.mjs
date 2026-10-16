import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const results = [];
function test(name, fn) { const evidence = fn(); results.push({ name, evidence }); }

// Execute the actual packaging logic with an in-memory filesystem. No production writes/deletes.
const deploy = read('工程/题库调研/deploy.mjs')
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify('file:///D:/audit/engineering/tools/deploy.mjs'))
  .replace(/^export .*;?\r?$/gm, '');
const wl = await import('../../工程/题库调研/_whitelist.mjs');
function pack(mode, fault, nestedName = 'sample.json') {
  let copied = [], logs = [], errors = [], exits = [];
  const fakeFs = {
    existsSync: () => true, mkdirSync() {}, writeFileSync() {},
    copyFileSync(s, d) { if (fault === 'copy' && s.endsWith('app.js')) throw Error('injected EACCES'); copied.push(d); },
    statSync: () => ({ size: 1 }),
    readdirSync(p, options) {
      if (options && /[\\/]site[\\/]data$/.test(p)) {
        if (fault === 'readdir') throw Error('injected EACCES');
        return [{ name: nestedName, isFile: () => true, isDirectory: () => false }];
      }
      if (!options && p.endsWith('site_dist')) return wl.FILES.concat(wl.DIRS);
      return [];
    }
  };
  const ctx = { fs: fakeFs, path, fileURLToPath, safeRmSync: () => true, ...wl,
    process: { argv: [], exit: c => { exits.push(c); throw Error('exit ' + c); } },
    console: { log: x => logs.push(String(x)), error: x => errors.push(String(x)) },
    SharedArrayBuffer: undefined };
  vm.createContext(ctx); vm.runInContext(deploy, ctx);
  ctx.main(mode);
  return { copied: copied.map(x => path.relative('/audit', x)), errors, exits, lastLog: logs.at(-1) };
}
test('pack-copy-failure-full', () => pack('full', 'copy'));
test('pack-copy-failure-incremental', () => pack('inc', 'copy'));
test('pack-directory-read-failure', () => pack('full', 'readdir'));
test('nested-secret-file-accepted', () => pack('full', null, '.env'));
test('current-bio-explain-divergence', () => {
  const man = JSON.parse(read('site/data/manifest.json'));
  const sub = man.semesters.flatMap(s => s.subjects).find(s => s.id === 'bio');
  const pack = JSON.parse(read('工程/题库调研/packs/大二/explain/生物化学.json'));
  const counts = new Map(), merged = {};
  let rawCount = 0;
  for (const c of sub.explain.chapters) {
    const data = JSON.parse(read('site/data/' + c.file));
    for (const [k, v] of Object.entries(data)) { counts.set(k, (counts.get(k) || 0) + 1); merged[k] = v; rawCount++; }
  }
  const questions = [sub.jiguang, sub.extension].flatMap(g => JSON.parse(read('site/data/' + g.file)));
  const activeIds = new Set(questions.map(q => q.id));
  const missing = Object.keys(pack).filter(k => !(k in merged));
  return { packCount: Object.keys(pack).length, siteRawCount: rawCount, siteUniqueCount: Object.keys(merged).length,
    duplicateIds: [...counts.values()].filter(n => n > 1).length,
    siteOnly: Object.keys(merged).filter(k => !(k in pack)).length,
    packOnly: missing.length, missingForActiveQuestions: missing.filter(k => activeIds.has(k)).length,
    sampleMissingActiveIds: missing.filter(k => activeIds.has(k)).slice(0, 3),
    changedCommon: Object.keys(pack).filter(k => k in merged && JSON.stringify(pack[k]) !== JSON.stringify(merged[k])).length };
});
test('minute-version-collision', () => {
  const version = t => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return { first: version('2026-10-15T01:02:01Z'), second: version('2026-10-15T01:02:59Z') };
});
test('service-worker-version-does-not-bind-content', () => {
  let onFetch;
  const cache = new Map();
  const ctx = { URL, location: { origin: 'https://audit.invalid' },
    self: { location: { search: '?v=release-B' }, addEventListener: (n, f) => { if(n === 'fetch') onFetch = f; } },
    caches: { match: async r => cache.get(r.url), open: async () => ({ put: (r, v) => cache.set(r.url, v) }) },
    fetch: async () => ({ ok: true, type: 'basic', body: 'release-B bytes', clone() { return this; } }),
    Response: { error: () => ({ error: true }) }
  };
  vm.createContext(ctx); vm.runInContext(read('site/sw.js'), ctx);
  let response;
  onFetch({ request: { method: 'GET', url: 'https://audit.invalid/data/packs/a.json?v=release-A' }, respondWith: p => response = p });
  return response.then(r => ({ requestedVersion: 'release-A', returnedBody: r.body }));
});
test('pending-question-shard-blocks-first-render', async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM, VirtualConsole } = require('C:/Users/Pengcheng_Li/.workbuddy/binaries/node/workspace/node_modules/jsdom');
  const dom = new JSDOM(read('site/index.html'), { url: 'https://audit.invalid/', runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window;
  let pendingShards = 0, clicksBound = 0;
  const add = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...args) => { if (type === 'click') clicksBound++; return add(type, ...args); };
  w.fetch = async url => {
    if (String(url).includes('/packs/')) { pendingShards++; return new Promise(() => {}); }
    return { ok: true, json: async () => JSON.parse(read('site/' + String(url).split('?')[0])) };
  };
  w.eval(read('site/app.js'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const evidence = { pendingShards, viewEmpty: w.document.getElementById('view').innerHTML === '', documentClickHandlers: clicksBound };
  w.close(); return evidence;
});
// Async evidence resolution.
for (const r of results) r.evidence = await r.evidence;
const out = JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2);
fs.writeFileSync(path.join(ROOT, '文档/前端审计_20261015/evidence.json'), out);
console.log(out);
