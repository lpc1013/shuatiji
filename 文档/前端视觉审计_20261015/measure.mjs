import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const css = fs.readFileSync(path.join(root, 'site/styles.css'), 'utf8');
const lum = hex => {
  const c = hex.replace('#','').match(/../g).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
  return c[0]*.2126+c[1]*.7152+c[2]*.0722;
};
const pairs = [
  ['默认次要文字／白卡','#76828f','#ffffff'],
  ['默认次要文字／页面底色','#76828f','#f5f7fb'],
  ['默认成功文字／成功底色','#16a34a','#e7f6ee'],
  ['默认警告标签／警告底色','#f59e0b','#fef3e0'],
  ['水墨次要文字／白卡','#79898a','#ffffff'],
  ['中国风次要文字／卡片','#8c8271','#fffcf5'],
  ['建议次要文字／白卡','#526173','#ffffff']
].map(([name,fg,bg]) => { const a=lum(fg),b=lum(bg);const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05); return {name,fg,bg,ratio:+ratio.toFixed(3),normalTextAA:ratio>=4.5}; });
const result = {
  method:'Static CSS token calculation, no browser computed styles or screenshots',
  contrast:pairs,
  defaultBasePx:15,
  nominalTextPx:{small:15*.85,tag:15*.78,englishSectionLabel:15*.68,englishModeDescription:15*.68,englishReaderSectionHeading:15*.72},
  desktopModeGrid:{columns:4,entries:6,rows:[4,2]},
  tabletNominal:{viewport:768,appMax:600,totalOuterWhitespace:168},
  playerNominal:{viewport:1440,maxWidth:600,totalOuterWhitespace:840},
  readerCascade:{mobileRuleLine:833,laterBaseLine:955,mobileIntendedWordEm:1.85,laterWinningWordEm:2.35,mobileIntendedPadding:'16px 16px 22px',laterWinningPadding:'30px 22px 40px'},
  checks:{globalFocusVisible:css.includes(':focus-visible{outline:2px'),globalReducedMotion:css.includes('animation:none!important'),largeTouchTargetsForCommonControls:css.includes('.btn:not(.sm),.chip,.tab,.mode,.qitem{min-height:44px;}')}
};
fs.writeFileSync(path.join(dir,'measurements.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
