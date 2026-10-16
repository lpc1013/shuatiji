// 溢出探针：对比 本地(改后) vs 线上(改前) 在 390px 视口下的横向溢出
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const targets = [
    ['local-fixed', 'http://127.0.0.1:8790/index.html'],
    ['online-before', 'https://www.lql170.cn/'],
  ];
  for (const [name, url] of targets) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) { console.log(name, 'goto warn:', e.message.split('\n')[0]); }
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const doc = document.scrollingElement;
      const vw = document.documentElement.clientWidth;
      const out = [];
      if (doc.scrollWidth > vw + 1) {
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect();
          if (b.right > vw + 1 && b.width > 0) {
            out.push(`${el.tagName}.${(el.className + '').split(' ')[0]} right=${Math.round(b.right)} w=${Math.round(b.width)}`);
            if (out.length >= 12) break;
          }
        }
      }
      return { vw, scrollW: doc.scrollWidth, overflow: doc.scrollWidth - vw, offenders: out };
    });
    console.log(`[${name}] viewport=${r.vw} scrollWidth=${r.scrollW} overflow=${r.overflow}px`);
    r.offenders.forEach(o => console.log('   ', o));
    await page.close();
  }
  await browser.close();
})();
