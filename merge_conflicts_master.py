# -*- coding: utf-8 -*-
"""合并「站点已上线(site/data)」与「题源全库」两套解析未同步冲突为一份总排期表。

输入：
  _conflict_v2.json      —— 站点已上线 大二3科 结构化解析冲突（phase-1 产出）
  _allbank_conflicts.json —— 题源全库 63科 Markdown 解析冲突（修复前全景）
  _allbank_fix_changelog.json —— 铁证自动修正记录（用于标注 已自动修正）
输出：
  文档/冲突总表_合并去重.csv
  文档/冲突总表_合并去重_说明.md
"""
import json, os, re, csv, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, '_conflict_v2.json')
ALL = os.path.join(ROOT, '_allbank_conflicts.json')
CHG = os.path.join(ROOT, '_allbank_fix_changelog.json')


def norm_text(s):
    """题干归一化：只留 中英数字，用于跨源去重。"""
    return re.sub(r'[^0-9A-Za-z\u4e00-\u9fa5]', '', str(s or '')).lower()


def fmt_opts(o):
    if isinstance(o, dict):
        return ' | '.join(f"{k}.{v}" for k, v in sorted(o.items()))
    return str(o or '')


LEVEL_MAP = {
    'A': '🔴A-题库答案需修正',
    'A-': '🔴A--题库答案疑缺/多项',
    'B': '🟠B-解析自陈争议',
    'C': '🟡C-解析缺答案项',
    'P0': '🔴P0-结论直接矛盾',
    'P0e': '🔴P0e-显性矛盾标记',
    'P1': '🟡P1-选项质量存疑',
    'P2': '🟡P2-文本重叠度低',
}


def load_site():
    data = json.load(open(SITE, encoding='utf-8'))
    rows = []
    for r in data:
        decl = r.get('declared') or {}
        letters = ''.join(sorted(decl.keys())) if isinstance(decl, dict) else str(decl or '')
        conf = r.get('conflict')
        confs = ''.join(conf) if isinstance(conf, list) else str(conf or '')
        rows.append(dict(
            source='站点site(大二3科)', id=r.get('id', ''), grade='大二',
            subj=r.get('subname') or r.get('sub', ''), chapter=r.get('chapter', ''),
            q=r.get('q', ''), opts=fmt_opts(r.get('o')), a=r.get('a', ''),
            declared=letters, level=r.get('level', ''), how=r.get('kind', ''),
            conflict=confs, md=(r.get('text') or '')[:400],
            srcfile=r.get('srcfile', '')))
    return rows


def load_all(fix_ids):
    data = json.load(open(ALL, encoding='utf-8'))
    rows = []
    for r in data:
        rows.append(dict(
            source='题源全库', id=r.get('id', ''), grade=r.get('grade', ''),
            subj=r.get('subj', ''), chapter=r.get('chapter', ''),
            q=r.get('q', ''), opts=fmt_opts(r.get('o')), a=r.get('a', ''),
            declared=r.get('declared', ''),
            level=r.get('level', ''),
            how=r.get('how', ''),
            conflict=(r.get('extra', '') + '/' + r.get('missing', '')),
            md=(r.get('md') or '')[:400],
            fixed='Y' if r.get('id') in fix_ids else ''))
    return rows


def order_key(r):
    lv = r.get('级别', '') or ''
    rank = 0 if '🔴' in lv else (1 if lv.startswith('🟠') else 2)
    return (r['来源'], rank, r.get('年级', ''), r.get('科目', ''))


def main():
    fix_ids = set()
    if os.path.exists(CHG):
        for rec in json.load(open(CHG, encoding='utf-8')):
            fix_ids.add(rec['id'])

    site = load_site()
    allb = load_all(fix_ids)

    # 归一化题干去重（跨源）
    seen_text = {}
    dup_cross = 0
    # 先按文本登记全库，再判站点是否撞题干
    for r in allb:
        seen_text.setdefault(norm_text(r['q']), []).append(r)

    rows = []
    # 站点行
    for r in site:
        key = norm_text(r['q'])
        hits = seen_text.get(key, [])
        cross = ''
        if hits:
            dup_cross += 1
            cross = '与全库重复(%d)' % len(hits)
        rows.append(dict(来源=r['source'], 题目ID=r['id'], 年级=r['grade'], 科目=r['subj'],
                         章节=r['chapter'], 题干=r['q'], 选项=r['opts'], 题库标答=r['a'],
                         解析答案=r['declared'], 级别=LEVEL_MAP.get(r['level'], r['level']),
                         证据强度=r['how'], 已自动修正='', 跨源=cross,
                         解析摘录=r['md'], 源文件=r['srcfile']))
    for r in allb:
        rows.append(dict(来源=r['source'], 题目ID=r['id'], 年级=r['grade'], 科目=r['subj'],
                         章节=r['chapter'], 题干=r['q'], 选项=r['opts'], 题库标答=r['a'],
                         解析答案=r['declared'], 级别=LEVEL_MAP.get(r['level'], r['level']),
                         证据强度=r['how'], 已自动修正=r.get('fixed', ''), 跨源='',
                         解析摘录=r['md'], 源文件=''))

    rows.sort(key=order_key)

    out_csv = os.path.join(ROOT, '文档', '冲突总表_合并去重.csv')
    with open(out_csv, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['来源', '题目ID', '年级', '科目', '章节', '题干', '选项', '题库标答',
                    '解析答案', '级别', '证据强度', '已自动修正', '跨源标记', '解析摘录'])
        for r in rows:
            w.writerow([r.get(k, '') for k in ['来源', '题目ID', '年级', '科目', '章节', '题干',
                        '选项', '题库标答', '解析答案', '级别', '证据强度', '已自动修正', '跨源', '解析摘录']])

    # 统计
    c_src = collections.Counter(r['来源'] for r in rows)
    c_lvl = collections.Counter(r['级别'] for r in rows)
    fixed_cnt = sum(1 for r in rows if r['已自动修正'] == 'Y')
    out_md = os.path.join(ROOT, '文档', '冲突总表_合并去重_说明.md')
    with open(out_md, 'w', encoding='utf-8') as f:
        f.write('# 冲突总表_合并去重 说明\n\n')
        f.write('合并「站点已上线(site/data，phase-1)」与「题源全库(63科)」两套排查。\n\n')
        f.write(f'- 站点行：{c_src["站点site(大二3科)"]} 条（P0/P0e 结论直接矛盾为主）\n')
        f.write(f'- 全库行：{c_src["题源全库"]} 条（A/B/C 分级）\n')
        f.write(f'- 合计：{len(rows)} 行\n')
        f.write(f'- 已自动修正（题源铁证补丁）：{fixed_cnt} 条\n')
        f.write(f'- 跨源题干重复（站点与全库在题干层疑似同一题）：{dup_cross} 条\n\n')
        f.write('## 级别分布\n\n')
        for k, v in c_lvl.most_common():
            f.write(f'- {k}: {v}\n')
        f.write('\n> 说明：站点侧 id 命名（kaoyan_*）与全库 UUID 不重叠，跨源去重按“归一化题干”（去标点/空白后比对）。\n')

    print('written', out_csv, len(rows), 'rows')
    print('统计:', dict(c_src), '已自动修正', fixed_cnt, '跨源重复', dup_cross)
    print('级别:', dict(c_lvl))


if __name__ == '__main__':
    main()
