#!/usr/bin/env node
// 补充明细：matchedOther 来源拆分 + 24 个答案冲突逐题原文
import fs from 'fs';
import path from 'path';
const ROOT = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学/题库';
const BIO = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学/工程/题库调研/merged2/by_subject/生物化学.json';
const REP = 'D:/朝花夕拾 闲暇随笔/李沁玲/大二上/生物化学与分子生物学/工程/题库调研/audit_xuetang_bio.report.json';
function norm(s){return (s||'').toString().replace(/[\x00-\x1f]/g,' ').replace(/\s+/g,'').replace(/[，,。.；;：:、]/g,'').toLowerCase().trim();}
function parseCSVLine(line){const out=[];let cur='';let q=false;for(let i=0;i<line.length;i++){const c=line[i];if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=c;}else{if(c===','){out.push(cur);cur='';}else if(c==='"'){q=true;}else cur+=c;}}out.push(cur);return out;}

const chapterDirs=fs.readdirSync(ROOT,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith('_')).map(d=>d.name);
const LETTERS=['A','B','C','D','E'];
const newQ=[];
for(const ch of chapterDirs){const csv=path.join(ROOT,ch,ch+'.csv');if(!fs.existsSync(csv))continue;const raw=fs.readFileSync(csv,'utf8').replace(/^﻿/,'');const rows=raw.split(/\r?\n/).filter(r=>r.trim());for(let i=1;i<rows.length;i++){const c=parseCSVLine(rows[i]);if(c.length<9)continue;const[no,stem,A,B,C,D,E,ans,ansText]=c;const opts={A,B,C,D,E};const fpPos=norm(stem)+'|'+LETTERS.map(L=>norm(opts[L])).join('|');const fpSet=norm(stem)+'|'+LETTERS.map(L=>norm(opts[L])).sort().join('|');newQ.push({chapterFolder:ch,stem,opts,answer:(ans||'').toUpperCase(),fpPos,fpSet});}}
const bio=JSON.parse(fs.readFileSync(BIO,'utf8'));const existing=Array.isArray(bio)?bio:Object.values(bio);
const exFpPos=new Map(),exFpSet=new Map();
for(const q of existing){const st=q.stem||'';const o=q.options||{};const fpPos=norm(st)+'|'+LETTERS.map(L=>norm(o[L])).join('|');const fpSet=norm(st)+'|'+LETTERS.map(L=>norm(o[L])).sort().join('|');if(!exFpPos.has(fpPos))exFpPos.set(fpPos,[]);exFpPos.get(fpPos).push(q);if(!exFpSet.has(fpSet))exFpSet.set(fpSet,[]);exFpSet.get(fpSet).push(q);}

// matchedOther 来源拆分 + 冲突明细
const otherSrc={}; const conflicts=[];
for(const n of newQ){
  let hit=null; if(exFpPos.has(n.fpPos))hit=exFpPos.get(n.fpPos)[0]; else if(exFpSet.has(n.fpSet))hit=exFpSet.get(n.fpSet)[0];
  if(!hit)continue;
  if(hit.sourceType!=='xuetang'){
    const s=hit.sourceType||'(?)'; otherSrc[s]=(otherSrc[s]||0)+1;
    const newAnsText=norm(n.opts[n.answer]); const hitAnsText=norm((hit.options||{})[hit.answer]);
    if(newAnsText&&hitAnsText&&newAnsText!==hitAnsText){
      conflicts.push({ch:n.chapterFolder,newAns:n.answer,hitId:hit.id,hitSrc:hit.sourceType,stem:n.stem,newOpts:n.opts,newAnsText,hypAnsText:hitAnsText});
    }
  }
}
console.log('=== matchedOther 来源拆分 ===');
console.log(JSON.stringify(otherSrc,null,0));
console.log('\n=== 24 个答案冲突 逐题 ===');
for(const c of conflicts){
  console.log(`\n[${c.ch}] 新答=${c.newAns}  命中 ${c.hitId} (${c.hitSrc})`);
  console.log('  题干:', c.stem.slice(0,60));
  for(const L of LETTERS) console.log(`    ${L}. ${c.newOpts[L]}`);
  console.log(`  → 新答案选文: ${c.newAnsText.slice(0,40)} | 命中答案选文: ${c.hypAnsText.slice(0,40)}`);
}
