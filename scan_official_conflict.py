# -*- coding: utf-8 -*-
"""高精度真错提取器：扫描「解析自陈官方/参考答案与真答案不同或漏项」的题目。

原理：当解析里出现「本题答案应为D-E，但（当年）官方参考答案仅为D」「应选BE，但原答案为B」
等句式时，解析作者**明确声明了题库存疑答案与自己主张的答案不同**——这是最可靠的真·题库错误信号
（远优于字母比对）。输出 文档/高可信_解析自陈答案冲突清单.csv。
"""
import json, re, os, glob, csv, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '题源数据')


def norm(s):
    return re.sub(r'[^A-H]', '', str(s or '').upper())


PATS = [
    re.compile(r'(?:答案|应选|选项)\s*(?:应)?(?:该)?为\s*([A-H]{1,6})[^。；\n]{0,20}?(?:但|,|，)[^。；\n]{0,12}?'
               r'(?:官方|当年|原|参考|题目|给定)(?:的|给(?:出)?)?(?:参考)?答案(?:仅|只|为|是|为仅)?\s*([A-H]{1,6})'),
    re.compile(r'(?:原|参考|官方)(?:给出|公布|给定|指定)?(?:的)?(?:参考)?答案(?:仅|只|为|是|给)?\s*([A-H]{1,6})\s*'
               r'[^。；\n]{0,10}?(?:但|,|，)[^。；\n]{0,20}?(?:正确|准确|应)答案(?:应)?为\s*([A-H]{1,6})'),
    re.compile(r'本题(?:正确)?答案(?:应)?(?:该)?为\s*([A-H]{1,6})\s*[，,]\s*(?:但|而)[^。；\n]{0,14}?'
               r'(?:参考|原|官方|题目)?答案(?:仅|只|为|是|给)?\s*([A-H]{1,6})'),
]
OUT_CSV = os.path.join(ROOT, '文档', '高可信_解析自陈答案冲突清单.csv')


def load():
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
                            qs[q['id']] = (q.get('stem') or q.get('q') or '',
                                           q.get('options') or q.get('o') or {},
                                           norm(q.get('answer') or q.get('a')), grade, subj)
    return qs, exps


def main():
    qs, exps = load()
    seen, res = set(), []
    for qid, md in exps.items():
        if qid not in qs:
            continue
        stem, opts, ans, grade, subj = qs[qid]
        for pat in PATS:
            m = pat.search(md)
            if not m:
                continue
            g = m.groups()
            real, given = (norm(g[1]), norm(g[0])) if pat is PATS[1] else (norm(g[0]), norm(g[1]) if len(g) > 1 else '')
            if real and real != ans and set(real) <= set(opts) and qid not in seen:
                seen.add(qid)
                res.append((qid, grade, subj, ans, real, given, stem[:45]))
            break
    with open(OUT_CSV, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['题目ID', '年级', '科目', '题库答案', '解析主张应改为', '解析点名给定答案', '题干'])
        for r in res:
            w.writerow(r)
    print('解析自陈答案冲突题：', len(res))
    print('科目Top:', collections.Counter((r[1], r[2]) for r in res).most_common(12))
    print('->', OUT_CSV)


if __name__ == '__main__':
    main()
