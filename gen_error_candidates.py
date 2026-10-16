# -*- coding: utf-8 -*-
"""内容级候选筛选器：把「声明答案字母」映射到当前选项内容，判断该内容是否在解析中被正面讨论，
以此区分 真错(TP：题库答案错) 与 过期字母(FP：题库答案其实对)。

判别：present(L)=选项[L]文字与解析正文的 2-gram 交集规模。
  若 present(declared) >= present(stored)  -> 声明的选项内容确是解析讨论重点 -> 判 GENUINE（题库疑错）
  若 present(stored)   >  present(declared)  -> 声明字母内容不在解析、题库内容在解析 -> 判 STALE（题库疑对）

先用 75 条已人工标注样本验证准确率；达标后对全部 648 A 类候选排序输出“题库疑错”清单。
"""
import json, re, os, glob, collections, random

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '题源数据')
ALL = os.path.join(ROOT, '_allbank_conflicts.json')

CUT_RE = re.compile(r'(教材出处|课本出处|易错点|答案依据|正确答案依据|##\s*选项分析)')


def ngrams(s, n=2):
    s = re.sub(r'[^0-9A-Za-z\u4e00-\u9fa5]', '', str(s or ''))
    return {s[i:i + n] for i in range(len(s) - n + 1)} if len(s) >= n else ({s} if s else set())


def body_of(md):
    c = CUT_RE.search(md or '')
    return md[:c.start()] if (c and c.start() > 40) else (md or '')


def present(letter, opts, bg):
    t = (opts or {}).get(letter, '')
    return len(grams_cache.get(letter, set()) & bg)


def build():
    qs, exps = {}, {}
    for grade in sorted(os.listdir(SRC)):
        gdir = os.path.join(SRC, grade)
        if not os.path.isdir(gdir):
            continue
        for subj in sorted(os.listdir(gdir)):
            tdir = os.path.join(gdir, subj, '3.整合题库')
            if not os.path.isdir(tdir):
                continue
            for fp in glob.glob(os.path.join(tdir, '*.json')):
                base = os.path.basename(fp)
                try:
                    data = json.load(open(fp, encoding='utf-8'))
                except Exception:
                    continue
                if base.startswith('解析') or '解析对照' in base:
                    if isinstance(data, dict):
                        for k, v in data.items():
                            if isinstance(v, str):
                                exps[k] = (exps.get(k, '') + '\n' + v)
                elif isinstance(data, list):
                    for q in data:
                        if isinstance(q, dict) and q.get('id'):
                            qs[q['id']] = (q.get('options') or q.get('o') or {}, exps.get(q['id'], '') or '')
    return qs, exps


def classify(md, opts, stored, declared):
    body = ngrams(body_of(md))
    if not declared or declared[0] not in opts:
        return 'UNDET', 0, 0
    dletter = declared[0]  # 声明答案字母（取第一个）
    sletter = (stored or '')[:1]
    pd = len(ngrams(opts.get(dletter, '')) & body)
    ps = len(ngrams(opts.get(sletter, '')) & body) if sletter in opts else -1
    if ps < 0:
        return 'UNDET', pd, ps
    return ('GENUINE' if pd >= ps else 'STALE'), pd, ps


if __name__ == '__main__':
    qs, exps = build()
    data = json.load(open(ALL, encoding='utf-8'))

    # --- 用 75 条已知标注验证 ---
    # item 50：随机种子42 + 按(年级,科目)排序，与 sample_item_review.py 一致
    items = [r for r in data if r['level'] in ('A', 'A-') and r['how'] == 'item']
    random.seed(42)
    isample = sorted(random.sample(items, 50), key=lambda r: (r['grade'], r['subj']))
    item_verdict = {1:'FP',2:'FP',3:'FP',4:'FP',5:'FP',6:'FP',7:'FP',8:'FP',9:'Z',10:'FP',11:'FP',12:'FP',13:'TP',14:'FP',15:'FP',16:'FP',17:'FP',18:'FP',19:'FP',20:'FP',21:'FP',22:'FP',23:'FP',24:'FP',25:'FP',26:'FP',27:'FP',28:'FP',29:'FP',30:'TP',31:'TP',32:'FP',33:'TP',34:'TP',35:'Z',36:'FP',37:'FP',38:'FP',39:'FP',40:'FP',41:'FP',42:'FP',43:'FP',44:'TP',45:'Z',46:'TP',47:'FP',48:'FP',49:'FP',50:'FP'}
    cm = collections.Counter()
    for i, r in enumerate(isample, 1):
        opts, md = qs.get(r['id'], (r['o'], r.get('md', '')))
        pred, _, _ = classify(r.get('md') or md, r['o'], r['a'], r['declared'])
        truth = 'GENUINE' if item_verdict[i] == 'TP' else ('STALE' if item_verdict[i] == 'FP' else None)
        if truth:
            cm[(truth, pred)] += 1
    print('== item 类 判别器校准（TP=真错/FP=题库对） ==')
    tp = cm[('GENUINE', 'GENUINE')]; fn = cm[('GENUINE', 'STALE')]
    fp = cm[('STALE', 'GENUINE')]; tn = cm[('STALE', 'STALE')]
    print(f'  GENUINE预测中真错(命中TP)={tp}，其中其实题库对(误伤FP->GENUINE)={fn}？')
    print(f'  矩阵: TP&GENUINE={tp} TP&STALE={fn} FP&GENUINE={fp} FP&STALE={tn}')
    prec = tp / (tp + fp) if (tp + fp) else 0
    rec = tp / (tp + fn) if (tp + fn) else 0
    print(f'  “判GENUINE”的精确率≈{prec:.0%}、召回≈{rec:.0%}')

    # --- 应用到全部 648 A 类 ---
    genuine, stale, undet = [], [], []
    bysub = collections.Counter()
    for r in data:
        if r['level'] not in ('A', 'A-'):
            continue
        opts, md = qs.get(r['id'], (r['o'], r.get('md', '')))
        pred, pd, ps = classify(r.get('md') or md, r['o'], r['a'], r['declared'])
        if pred == 'GENUINE':
            genuine.append((r, pd, ps)); bysub[(r['grade'], r['subj'])] += 1
        elif pred == 'STALE':
            stale.append(r)
        else:
            undet.append(r)
    print('\n== 全库 A 类 648 判别分布 ==')
    print(f'  GENUINE(题库疑错)={len(genuine)}  STALE(题库疑对)={len(stale)}  UNDET={len(undet)}')
    print('  GENUINE Top科目:', bysub.most_common(12))
    json.dump([dict(id=r['id'], grade=r['grade'], subj=r['subj'], chapter=r['chapter'],
                    q=r['q'], o=r['o'], a=r['a'], declared=r['declared'], how=r['how'],
                    md=r.get('md', '')[:600]) for r, pd, ps in genuine],
              open(os.path.join(ROOT, '_genuine_candidates.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('  -> _genuine_candidates.json')
