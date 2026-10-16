// 修复验收截图：390 手机首页 / 1440 桌面首页 / 390 沉浸阅读页
const { chromium } = require('playwright');
const path = require('path');
const OUT = __dirname;

(async () => {
  const browser = await chromium.launch();
  const url = 'http://127.0.0.1:8790/index.html';

  // 手机首页
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'fixed-home-390.png') });

  // 桌面首页（V01：账号按钮可见性 + 命中测试）
  let d = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await d.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await d.waitForTimeout(1200);
  await d.screenshot({ path: path.join(OUT, 'fixed-home-1440.png') });
  // V01 命中测试：账号按钮中心点 elementFromPoint 必须命中按钮自身
  const hit = await d.evaluate(() => {
    const btn = document.querySelector('#accountBtn');
    if (!btn) return { exists: false };
    const b = btn.getBoundingClientRect();
    const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { exists: true, rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }, hitIsBtn: el === btn || btn.contains(el), hitTag: el && el.tagName + '.' + (el.className + '').split(' ')[0] };
  });
  console.log('[V01 hit-test]', JSON.stringify(hit));

  // 沉浸阅读页（V05：手机断点不再被桌面间距覆盖）——从单词页进入
  await page.click('button.tab[data-tab="english"]').catch(e => console.log('tab click:', e.message));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, 'fixed-english-390.png') });

  await browser.close();
  console.log('done');
})();
