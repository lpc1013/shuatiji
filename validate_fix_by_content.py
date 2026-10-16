# -*- coding: utf-8 -*-
"""抽查 ironclad 自动修正（answer=declared）的内容一致性，防止 '解析字母过期/选项重排'
导致把正确答案改成错误字母。对每条样本打印 题干/选项/新答案/解析片段，供人工判定。"""
import json, os, random, glob, re

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '题源数据')
CHG = os.path.join(ROOT, '_allbank_fix_changelog.json')
OUT = os.path.join(ROOT, '文档', '铁证修正_内容抽查_25条.md')


def exp_map(grade, subj):
    m = {}
    tdir = os.path.join(SRC, grade, subj, '3.整合题库')
    for fp in glob.glob(os.path.join(tdir, '解析*.json')) + glob.glob(os.path.join(tdir, '*解析对照*.json')):
        try:
            d = json.load(open(fp, encoding='utf-8'))
        except Exception:
            continue
        if isinstance(d, dict):
            for k, v in d.items():
                if isinstance(v, str):
                    m[k] = v
    return m


def main():
    log = json.load(open(CHG, encoding='utf-8'))
    uniq = {r['id']: r for r in log}     # 去重（同 id 多文件）
    recs = list(uniq.values())
    print('唯一修正条目:', len(recs))
    random.seed(7)
    sample = random.sample(recs, min(25, len(recs)))

    # 建 grade/subj 缓存
    cacheexp = {}
    by_subj = {}
    for r in recs:
        fp = r['file']
        parts = fp.replace('\\', '/').split('/')
        gi = parts.index('题源数据')
        grade, subj = parts[gi + 1], parts[gi + 2]
        by_subj[(grade, subj)] = fp

    lines = ['# 铁证自动修正（answer=declared）内容一致性抽查（25 条，种子7）\n\n'
             '> 判定标准：新答案字母所指的**选项内容**是否确为正确答案。\n'
             '> OK=内容正确（修正成立）；STALE=字母过期指向错误选项（需回滚，改按内容改）；存疑\n\n']
    for i, r in enumerate(sample, 1):
        fp = r['file']
        parts = fp.replace('\\', '/').split('/')
        gi = parts.index('题源数据')
        grade, subj = parts[gi + 1], parts[gi + 2]
        fname = os.path.basename(fp)
        # 定位当前题目
        d = json.load(open(fp, encoding='utf-8'))
        q = next((x for x in d if isinstance(x, dict) and x.get('id') == r['id']), None)
        if (grade, subj) not in cacheexp:
            cacheexp[(grade, subj)] = exp_map(grade, subj)
        md = cacheexp[(grade, subj)].get(r['id'], '(无解析)')
        # 冲突解析中是否显式声明该字母为正解（故可反推字母是否新鲜）
        new = q.get('answer')
        lines.append(f'\n## [{i:02d}] {grade}·{subj} · {fname} · id={r["id"][:12]}\n\n')
        lines.append(f'**题干**：{(q.get("stem") or "")[:80]}\n\n')
        for k in sorted(q.get('options') or {}):
            mark = '  ←新答案' if k == new else ''
            lines.append(f'- {k}. {q["options"][k]}{mark}\n')
        lines.append(f'\n**原答案={r["old_answer"]}  修正为={new}**\n\n')
        seg = md or ''
        mm = re.search(r'(##\s*正确答案[^\n]*\n+.{0,30}|[A-H][，,]?\s*(?:对|错)[^。\n]{0,30}为本题正确答案)', seg)
        lines.append('解析要点：' + (mm.group(0).replace(chr(10),' ') if mm else seg[:120]) + '\n')
        lines.append('```\n' + (seg[:700]) + '\n```\n')

    open(OUT, 'w', encoding='utf-8').write(''.join(lines))
    print('written', OUT)


if __name__ == '__main__':
    main()
