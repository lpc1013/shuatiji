# -*- coding: utf-8 -*-
"""内容级「解析未同步」校验（高精度版）：绕开失效的“选项字母标注”，
只在「为本题正确答案」之前按**选项文字**定位正确选项，杜绝过期字母假阳性。

判定：
  - 解析出现「为本题正确答案」，其前 ~30 字内能匹配到某选项文字(2-gram重叠>=3) → 该选项即解析认定的正确选项(内容级)
  - 该集合 == 题库 answer → CONSISTENT(题库正确)
  - 该集合 != 题库 answer → CONFLICT(真冲突，建议按内容修正)
  - 找不到上述强信号 → UNDET(不硬判)
"""
import json, re, os, glob, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '题源数据')

BLOCK_RE = re.compile(r'\*\*\s*原题解析\s*\*\*(.*?)(?:\*\*\s*原题课本出处|^\s*#{1,4}\s|\Z)', re.S | re.M)
CUT_RE = re.compile(r'(教材出处|课本出处|易错点|答案依据|正确答案依据|##\s*选项分析)')
MARK_OK = re.compile(r'为(?:本题(?:的)?|之)?正确答案')
GRAIN = re.compile(r'[（(【\[]\s*[A-H]{1,6}\s*(?:对|错)')


def norm_letters(s):
    return re.sub(r'[^A-H]', '', str(s or '').upper())


def body_of(md):
    m = BLOCK_RE.search(md)
    b = m.group(1) if m else md
    if len(b) < 40:
        b = md
    c = CUT_RE.search(b)
    if c and c.start() > 40:
        b = b[:c.start()]
    return b


def ngrams(s, n=2):
    s = re.sub(r'[^0-9A-Za-z\u4e00-\u9fa5]', '', str(s or ''))
    return {s[i:i + n] for i in range(len(s) - n + 1)} if len(s) >= n else ({s} if s else set())


def content_answer(md, opts):
    b = body_of(md)
    b2 = GRAIN.sub('（？', b)                 # 抹掉（B对/B错）字母串，避免干扰文字窗口
    opt_grams = {k: ngrams(v) for k, v in opts.items()}
    ans = set()
    for m in MARK_OK.finditer(b2):
        win = b2[max(0, m.start() - 30): m.start()]
        wg = ngrams(win)
        best, bestk = 0, None
        for k, g in opt_grams.items():
            inter = len(g & wg)
            if inter > best:
                best, bestk = inter, k
        if bestk and best >= 3:
            ans.add(bestk)
    return ans


def main():
    tied = []       # (题库答案, 内容答案, 题干, 科目)
    n_pair = 0
    stat = collections.Counter()
    per_letter_known = collections.Counter()
    for grade in sorted(os.listdir(SRC)):
        gdir = os.path.join(SRC, grade)
        if not os.path.isdir(gdir):
            continue
        for subj in sorted(os.listdir(gdir)):
            tdir = os.path.join(gdir, subj, '3.整合题库')
            if not os.path.isdir(tdir):
                continue
            qs, exps = {}, {}
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
                                           norm_letters(q.get('answer') or q.get('a')))
            for qid, md in exps.items():
                if qid not in qs:
                    continue
                stem, opts, ans = qs[qid]
                if not ans or not opts:
                    continue
                n_pair += 1
                ca = content_answer(md, opts)
                if not ca:
                    stat['UNDET'] += 1
                    continue
                if ca == set(ans):
                    stat['CONSISTENT'] += 1
                else:
                    stat['CONFLICT'] += 1
                    per_letter_known[(grade, subj)] += 1
                    tied.append(dict(grade=grade, subj=subj, id=qid, stem=stem[:80],
                                     a=ans, content=''.join(sorted(ca))))
    print('配对解析:', n_pair, '| 内容判定:', dict(stat))
    print('真冲突(内容级,题库≠解析):', len(tied))
    print('Top 科目:', per_letter_known.most_common(15))
    json.dump(tied, open(os.path.join(ROOT, '_content_conflicts.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('-> _content_conflicts.json')


if __name__ == '__main__':
    main()
