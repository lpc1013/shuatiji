// V06-V12 视觉验收：截图 + 布局断言
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.resolve(__dirname);

(async () => {
  const browser = await chromium.launch();
  const R = [];

  // 手机 390：首页顺序（主行动应在统计之前）+ 溢出检测
  let pg = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await pg.goto('http://127.0.0.1:8790/index.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(800);
  const order = await pg.evaluate(() => {
    const v = document.getElementById('view');
    const kids = [...v.children].map(e => e.className || e.tagName);
    return kids;
  });
  R.push('手机首页子元素顺序: ' + JSON.stringify(order));
  const ctaTop = await pg.evaluate(() => {
    const c = document.querySelector('.cont-card, .start-cta');
    const s = document.querySelector('.stat-grid');
    if (!c || !s) return 'MISSING';
    return c.getBoundingClientRect().top <= s.getBoundingClientRect().top ? 'CTA在统计之前 ✓' : 'CTA在统计之后 ✗';
  });
  R.push('V06 主行动位置: ' + ctaTop);
  const ovf = await pg.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
  R.push('390 横向溢出: ' + ovf + 'px');
  // 溢出检测进阶
  const ovf2 = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  R.push('390 document 横向溢出: ' + ovf2 + 'px');
  await pg.screenshot({ path: path.join(OUT, 'v6-home-390.png'), fullPage: false });

  // 设置页 390：偏好设置应在云同步卡之前
  await pg.click('[data-tab="me"]');
  await pg.waitForTimeout(600);
  const meOrder = await pg.evaluate(() => {
    const v = document.getElementById('view');
    const pref = v.querySelector('.me-data-start');
    const acct = v.querySelector('[data-account-card]');
    const firstCard = [...v.children].find(e => e.classList && e.classList.contains('card'));
    return {
      firstCardIsPref: firstCard ? (firstCard.querySelector('input,select,.pref') != null || firstCard.textContent.slice(0, 30)) : 'none',
      acctAfterMarker: acct && pref ? (acct.compareDocumentPosition(pref) & Node.DOCUMENT_POSITION_PRECEDING) > 0 : 'n/a'
    };
  });
  R.push('V11 设置页: ' + JSON.stringify(meOrder));
  await pg.screenshot({ path: path.join(OUT, 'v11-me-390.png'), fullPage: false });
  await pg.close();

  // 桌面 1440：mode-grid 3 列 + 截图
  pg = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await pg.goto('http://127.0.0.1:8790/index.html', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(800);
  const cols = await pg.evaluate(() => getComputedStyle(document.querySelector('.mode-grid')).gridTemplateColumns.split(' ').length);
  R.push('V07 桌面 mode-grid 列数: ' + cols + (cols === 3 ? ' ✓' : ' ✗（期望 3）'));
  await pg.screenshot({ path: path.join(OUT, 'v7-home-1440.png'), fullPage: false });

  // 英语页：统计折叠
  await pg.click('[data-tab="english"]');
  await pg.waitForTimeout(1500);
  const engFold = await pg.evaluate(() => {
    const d = document.querySelector('.eng-stats-fold');
    return d ? ('折叠条存在, open=' + d.hasAttribute('open')) : 'MISSING';
  });
  R.push('V10 英语统计折叠: ' + engFold);
  await pg.screenshot({ path: path.join(OUT, 'v10-english-1440.png'), fullPage: false });
  await pg.close();

  await browser.close();
  console.log(R.join('\n'));
})().catch(e => { console.error('PROBE FAIL', e); process.exit(1); });
