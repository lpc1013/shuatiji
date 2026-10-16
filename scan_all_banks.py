# -*- coding: utf-8 -*-
"""全题库「解析未同步」扫描：覆盖 题源数据/<年级>/<科目>/3.整合题库/ 下所有题目+解析。

题目文件：极光题_*.json / 扩展题_*.json（字段 stem|q, options|o, answer|a）
解析文件：解析_*.json（dict: 题目id -> Markdown），其中「## 正确答案」段即解析认定的答案。

判定：
  解析声明的答案字母集合 与 题目 answer 字段不一致 => 冲突候选
用法: python scan_all_banks.py [输出json]
"""
import json, re, sys, os, glob, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '题源数据')
sys.stdout.reconfigure(encoding='utf-8')

NB = r'(?![A-Za-z0-9])'
NBC = r'(?![A-Za-z0-9\u4e00-\u9fa5])'

# 解析中「宣告答案」的各种写法（Markdown 场景）
DECL = [
    (re.compile(r'#{1,4}\s*正确答案\s*\n+\s*\**\s*([A-H]{1,8})\s*\**\s*(?:\n|$)'), 'head'),
    (re.compile(r'#{1,4}\s*答案\s*\n+\s*\**\s*([A-H]{1,8})\s*\**\s*(?:\n|$)'), 'head'),
    (re.compile(r'(?:正确答案|标准答案|本题答案|答案)\s*[：:]\s*\**\s*([A-H]{1,8})\s*\**' + NBC), 'inline'),
    (re.compile(r'(?:正确答案|答案)\s*[是为]\s*\**\s*([A-H]{1,8})\s*\**' + NBC), 'inline'),
    (re.compile(r'(?:故选|故答|因此选|所以选|答案选|应选|本题选|答案应选|答案应为|正确答案应为)\s*[：:]?\s*\**\s*([A-H])' + NB), 'concl'),
    (re.compile(r'答案\s*[：:]?\s*\**\s*([A-H])\s*\**' + NBC), 'inline'),
]
# 逐项标注式解析：“（A对）”“B错”“ACDE对”“D对E错”
ITEM_OK = re.compile(r'([A-H]{1,8})\s*[（(]?\s*对(?!错)')
ITEM_BAD = re.compile(r'([A-H]{1,8})\s*[（(]?\s*错')
# 题干“选错型”问法：此时正确答案 = 解析判为「错」的那一项
NEG_SEL = re.compile(r'(错误|不正确|不恰当|不对|有误|不合适|不符合|不参与|不属于|不包括|不存在|不发生|不会出现|不出现|不能|不会|未能|无关|除外|不是|不宜|缺乏|缺少|没有|无此|并非|不应)')
# 显性矛盾标记
MARK = re.compile(r'(但原答案|原(?:给出|官方)?(?:参考)?答案|题目指定|本题指定|请以教材为准|存在争议|有争议|并不严谨|不严谨|值得商榷|本题无正确答案|无正确答案|答案有误|题干不严谨|数据有更新|按\s*\d\s*版)')


BLOCK_RE = re.compile(r'\*\*\s*原题解析\s*\*\*(.*?)(?:\*\*\s*原题课本出处|^\s*#{1,4}\s|\Z)', re.S | re.M)
ALL_ABOVE = re.compile(r'(以上|上述|上列|各项|以上各项)[^。；]{0,6}(都|均|全|皆)?(正确|对|是|可|属于)')


def parse_block(md):
    """优先只用「原题解析」段落（课本出处段的标注常与正文不一致）"""
    m = BLOCK_RE.search(md)
    body = m.group(1) if m else md
    return body if len(body) > 40 else md


def item_marks(md):
    ok, bad = set(), set()
    for m in ITEM_OK.finditer(md):
        ok |= set(m.group(1))
    for m in ITEM_BAD.finditer(md):
        bad |= set(m.group(1))
    return ok, bad


def infer_from_items(md, neg_sel, opts):
    """从「X对 / X错」逐项标注反推解析认定的答案集合；返回 (推定集合, 解析提及的选项集合)"""
    body = parse_block(md)
    okb, badb = item_marks(body)
    if len(okb) + len(badb) >= 1:
        md = body
    ok, bad = item_marks(md)
    if len(ok) + len(bad) < 2:
        return None, set()
    ok = (ok & opts)
    bad = (bad & opts)
    # 单选风格：解析通常只把答案项标成唯一的「X对」(肯定型) 或唯一的「X错」(选错型)
    if len(ok) == 1:
        cand = ok
    elif neg_sel and len(bad) == 1:
        cand = bad
    elif ok:
        cand = ok
    else:
        cand = bad
    if not cand:
        return None, ok | bad
    return cand, ok | bad


def ans_set_cand(ok, bad, neg_sel, opts):
    if neg_sel:
        return bad - ok
    return ok - bad


# 最强信号：「（A错，为本题正确答案）」「D对，为本题正确答案」
ANSWER_MARK = re.compile(r'([A-H]{1,8})\s*[对错]\s*[，,、\s]*(?:为|是)?\s*(?:本题(?:的)?)?正确答案')
# 「（D对，故E为本题正确答案）」——答案字母在“故/因此”之后
ANSWER_MARK2 = re.compile(r'(?:故|因此|可见|综上)[，,]?\s*\**\s*([A-H]{1,8})\s*\**\s*为(?:本题)?正确答案')
# 次级信号：「综上，答案为X」「故选X」
DECL2 = re.compile(r'(?:综上|因此|可见)[^。\n]{0,12}?(?:答案|选)\s*[为是：:]?\s*\**\s*([A-H]{1,8})' + NBC)


def norm(s):
    return re.sub(r'[^A-H]', '', str(s or '').upper())


def tail_neg(stem):
    """只在题干尾部（问法所在）判断是否为“选错型”"""
    s = (stem or '')[-45:]
    return bool(NEG_SEL.search(s))


def declared(md):
    """返回 (字母集合, 证据列表)"""
    hits = collections.Counter()
    ev = []
    for rx, tag in DECL:
        for m in rx.finditer(md):
            letters = norm(m.group(1))
            if not letters:
                continue
            hits[letters] += 1
            ev.append(re.sub(r'\s+', ' ', md[max(0, m.start() - 60):m.end() + 80]).strip())
    if not hits:
        return set(), []
    # 取出现次数最多的答案字符串；再取其字母集合
    best = hits.most_common(1)[0][0]
    return set(best), ev[:3]


def load_subject(dirpath):
    """读取某科目 3.整合题库 下的题目与解析"""
    qs = {}
    exps = {}
    for fp in glob.glob(os.path.join(dirpath, '*.json')):
        base = os.path.basename(fp)
        try:
            data = json.load(open(fp, encoding='utf-8'))
        except Exception as e:
            print('  ! 读取失败', fp, e)
            continue
        if base.startswith('解析_') or '解析对照' in base:
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(v, str) and v.strip():
                        exps[k] = (exps.get(k, '') + '\n' + v).strip()
        elif isinstance(data, list) and data and isinstance(data[0], dict):
            for q in data:
                qid = q.get('id')
                if not qid:
                    continue
                stem = q.get('stem') or q.get('q') or ''
                opts = q.get('options') or q.get('o') or {}
                ans = q.get('answer') or q.get('a') or ''
                qs[qid] = dict(id=qid, q=stem, o=opts, a=ans, src=q.get('source') or q.get('s'),
                               chapter=q.get('chapter') or q.get('c'), file=base)
    return qs, exps


def main():
    out = []
    stat = collections.Counter()
    subjects = []
    for grade in sorted(os.listdir(SRC)):
        gdir = os.path.join(SRC, grade)
        if not os.path.isdir(gdir):
            continue
        for subj in sorted(os.listdir(gdir)):
            tdir = os.path.join(gdir, subj, '3.整合题库')
            if not os.path.isdir(tdir):
                continue
            qs, exps = load_subject(tdir)
            subjects.append((grade, subj, len(qs), len(exps)))
            stat['q'] += len(qs)
            stat['exp'] += len(exps)
            for qid, md in exps.items():
                q = qs.get(qid)
                if not q:
                    stat['exp_no_q'] += 1
                    continue
                ans = norm(q['a'])
                if not ans:
                    stat['q_no_ans'] += 1
                    continue
                stat['paired'] += 1
                m1 = None
                mk = set()
                for mm in ANSWER_MARK.finditer(md):
                    mk |= set(norm(mm.group(1)))
                for mm in ANSWER_MARK2.finditer(md):
                    mk |= set(norm(mm.group(1)))
                if mk:
                    m1 = type('M', (), {'group': lambda self, i: ''.join(sorted(mk)),
                                        'start': lambda self: 0, 'end': lambda self: 0})()
                m2 = DECL2.search(md)
                if m1:
                    dset, ev, how = set(norm(m1.group(1))), [re.sub(r'\s+', ' ', md[max(0, m1.start() - 60):m1.end() + 40])], 'mark'
                else:
                    dset, ev = declared(md)
                    how = 'decl'
                if not dset and m2:
                    dset, ev, how = set(norm(m2.group(1))), [], 'decl2'
                opts = set((q['o'] or {}).keys())
                # “以上都对 / 上述均正确”型选项：解析逐项肯定其余选项，实际与答案一致
                if len(ans) == 1 and ALL_ABOVE.search((q['o'] or {}).get(ans, '')):
                    if dset | set(ans) == opts or dset == opts:
                        continue
                mentioned = opts
                if not dset:
                    dset, mentioned = infer_from_items(md, tail_neg(q['q']), opts)
                    how = 'item'
                if not dset:
                    stat['no_decl'] += 1
                    continue
                stat['how_' + how] += 1
                # 多选：解析若只标了“错”项，推定应为「其余全选」
                if len(ans) > 1 and how == 'item':
                    ok, bad = item_marks(md)
                    alts = [dset, opts - (bad & opts), ok & opts]
                    if any(a == set(ans) for a in alts if a):
                        dset = set(ans)
                # 解析完全没提到答案项 -> 疑似串题/缺项，降级为 C
                if how == 'item' and not (set(ans) & mentioned):
                    out.append(dict(grade=grade, subj=subj, level='C', id=qid, q=q['q'], o=q['o'],
                                    a=q['a'], declared=''.join(sorted(dset)), evidence=[], marks=[],
                                    chapter=q['chapter'], src=q['src'], md=md[:1500], how=how))
                    stat['C_unmentioned'] += 1
                    continue
                marks = [re.sub(r'\s+', ' ', md[max(0, m.start() - 70):m.start() + 120]).strip()
                         for m in list(MARK.finditer(md))[:2]]
                if dset == set(ans):
                    if marks:
                        stat['ok_with_mark'] += 1
                        out.append(dict(grade=grade, subj=subj, level='B', id=qid, q=q['q'], o=q['o'],
                                        a=q['a'], declared=''.join(sorted(dset)), evidence=[], marks=marks,
                                        chapter=q['chapter'], src=q['src'], md=md[:1500], how=how))
                    continue
                # 冲突
                extra = dset - set(ans)
                missing = set(ans) - dset
                lvl = 'A' if extra else 'A-'
                stat['conflict'] += 1
                out.append(dict(grade=grade, subj=subj, level=lvl, id=qid, q=q['q'], o=q['o'],
                                a=q['a'], declared=''.join(sorted(dset)), evidence=ev, marks=marks,
                                chapter=q['chapter'], src=q['src'], md=md[:2000], how=how,
                                extra=''.join(sorted(extra)), missing=''.join(sorted(missing))))
    outp = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '_allbank_conflicts.json')
    json.dump(out, open(outp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('STAT', dict(stat))
    print('subjects', len(subjects), 'candidates', len(out), '->', outp)
    c = collections.Counter((r['grade'], r['subj'], r['level']) for r in out)
    for k, v in c.most_common(60):
        print('  ', k, v)


if __name__ == '__main__':
    main()
