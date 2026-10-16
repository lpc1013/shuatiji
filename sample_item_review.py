# -*- coding: utf-8 -*-
"""item 类冲突抽样复核：从「A/A- 且 how=item」中随机抽 50 条，生成待人工判定样本。"""
import json, os, random, csv

ROOT = os.path.dirname(os.path.abspath(__file__))
ALL = os.path.join(ROOT, '_allbank_conflicts.json')
OUT_MD = os.path.join(ROOT, '文档', 'item类抽样复核_50样本.md')
OUT_J = os.path.join(ROOT, '文档', 'item类抽样复核_判定.csv')


def main():
    data = [r for r in json.load(open(ALL, encoding='utf-8'))
            if r.get('level') in ('A', 'A-') and r.get('how') == 'item']
    print('item 类 A/A- 总数:', len(data))
    random.seed(42)
    sample = random.sample(data, 50)
    sample.sort(key=lambda r: (r['grade'], r['subj']))

    with open(OUT_MD, 'w', encoding='utf-8') as f:
        f.write('# item 类冲突抽样复核样本（50 条，随机种子 42）\n\n')
        f.write('> 对每条判断：解析给出的答案(declared)是否确与题库标答(a)真实冲突。\n')
        f.write('> 判定：TP=真冲突（题库答案确实错，按解析为准能改）；FP=误报（题库答案其实对，或矛盾源于解析笔误/出题争议）；存疑=证据不足。\n\n')
        for i, r in enumerate(sample, 1):
            f.write(f'\n## [{i:02d}] {r["grade"]}·{r["subj"]} · id={r["id"][:12]}\n\n')
            f.write(f'**题干**：{r["q"]}\n\n')
            opts = r.get('o') or {}
            for k in sorted(opts):
                f.write(f'- {k}. {opts[k]}\n')
            f.write(f'\n**题库标答**：{r["a"]}    **解析判定答案**(declared)：{r["declared"]}    '
                    f'[extra={r.get("extra","")} missing={r.get("missing","")}]\n\n')
            parsed = (r.get('md') or '')
            f.write('<details><summary>解析原文</summary>\n\n```\n' + parsed[:1400] + '\n```\n\n</details>\n')

    with open(OUT_J, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['序号', 'ID', '年级', '科目', '题干', '题库标答', '解析答案', '判定(TP/FP/存疑)', '理由'])
        for i, r in enumerate(sample, 1):
            w.writerow([i, r['id'], r['grade'], r['subj'], r['q'], r['a'], r['declared'], '', ''])
    print('written', OUT_MD, 'and', OUT_J)


if __name__ == '__main__':
    main()
