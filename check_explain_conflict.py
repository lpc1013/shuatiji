# -*- coding: utf-8 -*-
"""扫描解析(explain)与题库答案(a)冲突的题目 —— 「解析未同步」数据 BUG 排查 v2

分级：
  P0  解析给出明确结论(故选X/故答X/答案为X)或显性矛盾声明(正确答案应为X而非Y / 原答案为X)，
      且与题库答案不一致
  P1  解析对「答案选项」的定性(正确/错误)与题面问法相反
  P2  解析内容与本题(题干+选项)几乎无文字重合 —— 疑似解析串题/未同步

用法: python check_explain_conflict.py [输出json]
"""
import json, re, sys, os, glob, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'site', 'data')
SUBS = {'bio': '生物化学', 'immunology': '医学免疫学', 'physiology': '生理学'}
sys.stdout.reconfigure(encoding='utf-8')

NB = r'(?![A-Za-z0-9])'          # 字母后不能紧跟字母/数字（排除 CD4、C1q、B细胞 中的误判）
NBC = r'(?![A-Za-z0-9\u4e00-\u9fa5])'  # 字母后不能跟字母/数字/汉字（"答案为B细胞"不算结论）

# —— P0-a: 明确结论句 ——
CONCL = [
    (r'(?:故选|故答|因此选|所以选|答案选|应选|本题选|答案应为|正确答案应为|正确答案应|答案应选|故选答案){1}\s*[：:]?\s*([A-E])' + NB, 'concl'),
    (r'(?:正确答案|本题答案|答案)\s*[是为]\s*[：:]?\s*([A-E])' + NBC, 'concl'),
    (r'([A-E])\s*为正确答案' + NB, 'concl'),
    (r'选项\s*([A-E])\s*为正确答案', 'concl'),
]
# —— P0-b: 显性矛盾声明 ——
EXPLICIT = [
    r'(?:正确答案|答案)\s*应为\s*([A-E])\s*(?:而|而非|而不是|，|,)?\s*(?:非|不是)?\s*([A-E])',
    r'原(?:给出)?答案[为是：: ]\s*([A-E])',
    r'而原答案[为是]\s*([A-E])',
    r'(?:题目|本题)\s*指定\s*([A-E])',
    r'请以教材为准',
    r'但本题[给指]定?',
]
CONCL_RE = [(re.compile(p), tag) for p, tag in CONCL]
EXPLICIT_RE = [re.compile(p) for p in EXPLICIT]

# —— P1: 对选项的定性 ——
QUAL_BAD = re.compile(r'(?:选项\s*([A-E])|([A-E])\s*项)(?:(?!其他|其余|别的)[^。；\n]){0,25}?(?:是|为)?\s*(错误|不正确|不恰当|有误|不对|不符|不能|不属于|不适合|除外|不发生|不会发生|未发生)')
QUAL_GOOD = re.compile(r'(?:选项\s*([A-E])|([A-E])\s*项)(?:(?!其他|其余|别的)[^。；\n]){0,25}?(?:是|为)?\s*(正确|恰当|符合教材|符合|应当|为本题答案)')
NEG_RE = re.compile(r'(错误|不正确|不属于|不包括|除外|不是|不对|无关|不符合|不能|不宜|不恰当|不会发生|没有发生|未发生|不会出现|不出现|不易|并非|否定|不应|未能|缺少|缺乏)')


def load_questions():
    qmap = {}
    for sub in SUBS:
        for kind in ('jg', 'ext'):
            p = os.path.join(DATA, 'packs', '大二', f'{sub}-{kind}.json')
            if not os.path.exists(p):
                continue
            for q in json.load(open(p, encoding='utf-8')):
                q['_sub'], q['_kind'] = sub, kind
                qmap[q['id']] = q
    return qmap


def block_text(b):
    out = []
    if b.get('bf'):
        out.append(str(b['bf']))
    for blk in b.get('b', []):
        if not isinstance(blk, list) or not blk:
            continue
        k = blk[0]
        if k == 'p' and len(blk) >= 4:
            out.append(str(blk[3]))
        elif k == 'tb' and len(blk) >= 5:
            out.append(str(blk[2]))
            for row in blk[4] if isinstance(blk[4], list) else []:
                out.append(' | '.join(str(x) for x in row) if isinstance(row, list) else str(row))
        elif k == 'li' and len(blk) >= 3:
            for it in blk[2] if isinstance(blk[2], list) else []:
                out.append(str(it))
        elif k == 'h' and len(blk) >= 3:
            out.append(str(blk[2]))
    return '\n'.join(out)


def ctx(text, pat, width=90):
    hits = []
    for m in re.finditer(pat, text):
        s = max(0, m.start() - width // 2)
        hits.append(re.sub(r'\s+', ' ', text[s:m.end() + width // 2]))
        if len(hits) >= 3:
            break
    return hits


def overlap_ratio(text, q):
    """解析文本 与 题干+选项 的 2-gram 重合率"""
    def grams(s):
        s = re.sub(r'[\s\W_]+', '', str(s or ''))
        return set(s[i:i + 2] for i in range(len(s) - 1))
    tgt = grams(q.get('q'))
    for v in (q.get('o') or {}).values():
        tgt |= grams(v)
    if not tgt:
        return 1.0
    g = grams(text)
    return len(tgt & g) / len(tgt)


def main():
    qmap = load_questions()
    res = []
    stat = collections.Counter()
    for sub, subname in SUBS.items():
        for fp in sorted(glob.glob(os.path.join(DATA, 'explain', '大二', sub, '*.json'))):
            chapter = os.path.basename(fp)[:-5]
            try:
                data = json.load(open(fp, encoding='utf-8'))
            except Exception as e:
                print('LOAD FAIL', fp, e)
                continue
            for qid, b in data.items():
                stat['total'] += 1
                q = qmap.get(qid)
                if not q:
                    stat['no_q'] += 1
                    continue
                text = block_text(b)
                ans = str(q.get('a') or '').strip().upper()
                if not ans:
                    continue
                rec = dict(sub=sub, subname=subname, chapter=chapter, id=qid, q=q.get('q'),
                           o=q.get('o'), a=ans, src=q.get('s'), kind=q.get('_kind'),
                           text=text, srcfile=os.path.relpath(fp, ROOT))
                decl = collections.Counter()
                ev = []
                for rx, tag in CONCL_RE:
                    for m in rx.finditer(text):
                        L = m.group(1)
                        decl[L] += 1
                        ev.append(re.sub(r'\s+', ' ', text[max(0, m.start() - 60):m.end() + 60]))
                exp = []
                for rx in EXPLICIT_RE:
                    for m in rx.finditer(text):
                        exp.append(re.sub(r'\s+', ' ', text[max(0, m.start() - 70):m.end() + 70]))
                single = len(ans) == 1
                bad = [L for L in decl if (L != ans if single else L not in ans)]
                neg = bool(NEG_RE.search(q.get('q') or ''))
                # P1 定性冲突
                qbad = set()
                qgood = set()
                for m in QUAL_BAD.finditer(text):
                    qbad.add(m.group(1) or m.group(2))
                for m in QUAL_GOOD.finditer(text):
                    qgood.add(m.group(1) or m.group(2))
                p1 = None
                if single:
                    if neg and ans in qgood and ans not in qbad and not bad:
                        p1 = '题面问「错误/除外」，解析却判定答案项 %s 为正确' % ans
                    elif (not neg) and ans in qbad and ans not in qgood and not bad:
                        p1 = '题面问「正确/属于」，解析却判定答案项 %s 为错误' % ans
                elif ans and (set(ans) & qbad):
                    p1 = '多选题答案含 %s，解析却判定其为错误' % ''.join(sorted(set(ans) & qbad))
                ov = overlap_ratio(text, q)
                if bad:
                    rec.update(level='P0', conflict=sorted(bad, key=lambda L: -decl[L]),
                               declared=dict(decl), evidence=ev[:6], explicit=exp[:3])
                    stat['P0'] += 1
                    res.append(rec)
                elif exp and not bad:
                    rec.update(level='P0', conflict=[], declared=dict(decl),
                               evidence=ev[:3], explicit=exp[:3])
                    stat['P0e'] += 1
                    res.append(rec)
                elif p1:
                    rec.update(level='P1', conflict=[], declared=dict(decl), why=p1,
                               evidence=[], explicit=exp[:3])
                    stat['P1'] += 1
                    res.append(rec)
                elif ov < 0.06:
                    rec.update(level='P2', conflict=[], declared=dict(decl), why='解析文本与本题题干/选项 2-gram 重合率仅 %.3f' % ov,
                               evidence=[], explicit=exp[:2], ov=round(ov, 4))
                    stat['P2'] += 1
                    res.append(rec)
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '_conflict_v2.json')
    json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('STAT', dict(stat))
    lv = collections.Counter((r['level'], r['subname']) for r in res)
    for k, v in sorted(lv.items()):
        print('  ', k, v)


if __name__ == '__main__':
    main()
