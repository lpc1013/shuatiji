# -*- coding: utf-8 -*-
"""由 _allbank_conflicts.json 生成《全题库「解析未同步（数据 BUG）」排查报告》Markdown + CSV"""
import json, re, os, sys, csv, collections, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.stdout.reconfigure(encoding='utf-8')
SRC = os.path.join(ROOT, '_allbank_conflicts.json')
rows = json.load(open(SRC, encoding='utf-8'))

LVLNAME = {'A': '🔴 A', 'A-': '🔴 A', 'B': '🟠 B', 'C': '🟡 C'}
TENDENCY = {'mark': '题库答案错（解析有「为本题正确答案」铁证）',
            'decl': '题库答案错（解析「正确答案」段与答案不符）',
            'decl2': '题库答案错（解析结论句与答案不符）',
            'item': '需复核（由逐项标注反推）'}


def clip(s, n):
    s = re.sub(r'\s+', ' ', (s or '')).strip()
    return s[:n] + ('…' if len(s) > n else '')


def evidence(r):
    if r.get('evidence'):
        return clip(r['evidence'][0], 150)
    if r.get('marks'):
        return clip(r['marks'][0], 150)
    md = r.get('md', '')
    m = re.search(r'\*\*\s*原题解析\s*\*\*(.*)$', md, re.S)
    body = m.group(1) if m else md
    return clip(body, 150)


def ans_text(r, letter):
    return (r.get('o') or {}).get(letter, '')


grade_order = ['大一', '大二', '大三', '大四', '水平测试']
A = [r for r in rows if r['level'].startswith('A')]
B = [r for r in rows if r['level'] == 'B']
C = [r for r in rows if r['level'] == 'C']
for r in rows:
    r['_gi'] = grade_order.index(r['grade']) if r['grade'] in grade_order else 99
A.sort(key=lambda r: (r['_gi'], r['subj'], r['chapter'] or ''))
B.sort(key=lambda r: (r['_gi'], r['subj']))
C.sort(key=lambda r: (r['_gi'], r['subj']))

out = []
w = out.append
w('# 全题库「解析未同步（数据 BUG）」排查报告')
w('')
w('> **扫描范围**：`题源数据/` 全部年级与科目（大一 / 大二 / 大三 / 大四 / 水平测试），共 **63 个科目**  ')
w('> **题目总量**：**109 354 题**；**关联解析**：**82 136 条**；成功配对比对：**82 136 组**  ')
w('> **生成时间**：%s' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))
w('')
w('> 本报告是「题库 → 解析」全量体检，侧重于**解析给出的答案与题库 `answer` 字段相互矛盾**的题目。  ')
w('> 与《题库解析未同步（数据BUG）排查报告》的关系：那份针对站点已上线数据 `site/data`（大二 3 科，结构化解析）；'
  '本报告针对**题源数据全库**（63 科目，Markdown 原始解析），覆盖面更大。')
w('')

w('## 一、结论速览')
w('')
w('| 级别 | 类型 | 数量 | 含义 | 处置优先级 |')
w('|---:|---|---:|:---:|:---:|')
w('| 🔴 A | **解析答案 ≠ 题库答案** | %d | 刷题时“解析说一套、判分按另一套” | 立即核修 |' % len(A))
w('| 🟠 B | 解析**自陈争议/版本差异**（答案与解析一致，但解析明说“原答案为…”“存在争议”） | %d | 旧版数据 / 争议题，易被判错 | 尽快标注 |' % len(B))
w('| 🟡 C | 解析**没有提到答案项**（疑似解析串题、缺项、题目被换过） | %d | 解析基本不可用 | 排期重生成 |' % len(C))
w('| | **合计** | **%d** | | |' % (len(A) + len(B) + len(C)))
w('')
w('### A 类的构成（按证据强度）')
w('')
cc = collections.Counter((r['level'], r.get('how')) for r in A)
w('| 证据强度 | 数量 | 说明 |')
w('|---|---:|---|')
w('| `mark`：解析明写「X（错/对），**为本题正确答案**」 | %d | 铁证，几乎必为题库答案错 |' % (cc[('A', 'mark')] + cc[('A-', 'mark')]))
w('| `decl`：解析「## 正确答案」段 / 「故选X」结论句 | %d | 强证据 |' % (cc[('A', 'decl')] + cc[('A-', 'decl')] + cc[('A-', 'decl2')]))
w('| `item`：由「（A对）B错」逐项标注反推 | %d | 中证据，需人工抽查确认 |' % (cc[('A', 'item')] + cc[('A-', 'item')]))
w('')

w('### 按科目分布（A 类 Top 20）')
w('')
cnt = collections.Counter((r['grade'], r['subj']) for r in A)
tot = collections.Counter((r['grade'], r['subj']) for r in rows)
w('| 年级 | 科目 | 🔴A | 🟠B | 🟡C | 小计 |')
w('|---|---|--:|--:|--:|--:|')
for (g, s), n in cnt.most_common(20):
    w('| %s | %s | %d | %d | %d | **%d** |' % (
        g, s,
        sum(1 for r in A if (r['grade'], r['subj']) == (g, s)),
        sum(1 for r in B if (r['grade'], r['subj']) == (g, s)),
        sum(1 for r in C if (r['grade'], r['subj']) == (g, s)),
        tot[(g, s)]))
rest = len(A) - sum(n for _, n in cnt.most_common(20))
if rest:
    w('| — | 其余 %d 个科目 | %d | | | |' % (len(cnt) - 20, rest))
w('')

# —— A 类全量清单 ——
w('---')
w('')
w('## 二、🔴 A 类全量清单（%d 条）' % len(A))
w('')
w('字段说明：**标答**=题库 `answer`；**解析答案**=从解析中抽取的答案；**证据**=解析原文摘录；'
  '**倾向**=依据证据强度给出的初判。')
w('')
cur = None
idx = 0
for r in A:
    key = (r['grade'], r['subj'])
    if key != cur:
        cur = key
        w('')
        w('### %s · %s（%d 条）' % (r['grade'], r['subj'], cnt[key]))
        w('')
        w('| # | 章节 | 题干（节选） | 标答 | 解析答案 | 证据（解析原文） | 倾向 |')
        w('|---:|---|---|:---:|:---:|---|---|')
        idx = 0
    idx += 1
    w('| %d | %s | %s | `%s` | `%s` | %s | %s |' % (
        idx, clip(r['chapter'], 16), clip(r['q'], 46), r['a'], r['declared'],
        evidence(r).replace('|', '／'), TENDENCY.get(r.get('how'), '')))
w('')

# —— B 类 ——
w('---')
w('')
w('## 三、🟠 B 类：解析自陈争议 / 教材版本差异（%d 条）' % len(B))
w('')
w('答案与解析结论一致，但解析正文中出现「原答案为…」「答案应为…」「存在争议」「不严谨」等字样，'
  '说明该题答案经历过变更或本身有争议。刷题时若按解析理解可能被判错，建议统一加“争议题 / 旧版答案”标注。')
w('')
w('| # | 年级/科目 | 题干（节选） | 标答 | 争议原文摘录 |')
w('|---:|---|---|:---:|---|')
for i, r in enumerate(B, 1):
    w('| %d | %s/%s | %s | `%s` | %s |' % (
        i, r['grade'], r['subj'], clip(r['q'], 44), r['a'],
        (clip(r['marks'][0], 130) if r.get('marks') else evidence(r)).replace('|', '／')))
w('')

# —— C 类 ——
w('---')
w('')
w('## 四、🟡 C 类：解析未提及答案项（%d 条）' % len(C))
w('')
w('解析逐项点评了其他选项，却**完全没有提到答案所对应的选项**——通常是解析串题、题目被替换过、或解析生成时截取了错误的题。')
w('')
w('| # | 年级/科目 | 题干（节选） | 标答 | 解析逐项点评到的选项 | 解析开头 |')
w('|---:|---|---|:---:|---|---|')
for i, r in enumerate(C, 1):
    w('| %d | %s/%s | %s | `%s` | `%s` | %s |' % (
        i, r['grade'], r['subj'], clip(r['q'], 44), r['a'], r['declared'],
        evidence(r).replace('|', '／')))
w('')

# —— 典型样例 ——
w('---')
w('')
w('## 五、典型样例深度解析')
w('')
picks = [r for r in A if r.get('how') == 'mark'][:4] + [r for r in A if r.get('how') == 'decl'][:3] \
        + [r for r in A if r.get('how') == 'item'][:3]
for i, r in enumerate(picks, 1):
    w('### 样例 %d　%s · %s' % (i, r['grade'], r['subj']))
    w('')
    w('- **题干**：%s' % clip(r['q'], 300))
    w('')
    for k, v in (r.get('o') or {}).items():
        mark = ' ← **标答**' if r['a'] and k in r['a'] else ''
        w('    - %s. %s%s' % (k, v, mark))
    w('')
    w('- **题库标答**：`%s`　|　**解析给出的答案**：`%s`' % (r['a'], r['declared']))
    w('- **解析原文**：')
    w('')
    w('    > %s' % clip(r.get('md', ''), 600))
    w('')
    w('- **初判**：%s' % TENDENCY.get(r.get('how'), ''))
    w('')

w('---')
w('')
w('## 六、修复建议')
w('')
w('### 6.1 处置原则')
w('')
w('| 类别 | 数据侧动作 | 说明 |')
w('|---|---|---|')
w('| 🔴 A（`mark`/`decl` 证据） | 把题目 `answer` 改为解析认定的答案 | 解析有「为本题正确答案」铁证时，通常是题库答案录入/转换时出错 |')
w('| 🔴 A（`item` 证据） | 人工复核后二选一：改答案 或 重生成解析 | 逐项标注反推存在少量噪声，建议按科目抽查 10%% 后再批量改 |')
w('| 🟠 B | 增加 `disputed`/`note` 字段，写入版本与争议说明 | 刷题页加“争议题”角标，判分可宽容 |')
w('| 🟡 C | 删除该条解析并重新生成 | 解析与题不匹配，留着只会误导 |')
w('')
w('### 6.2 防复发：入库前必须过的 5 道校验')
w('')
w('1. **答案段一致性**：解析生成后抽取「## 正确答案 / 故X为本题正确答案 / 故选X」，与 `answer` 比对，不一致直接拦截。')
w('2. **逐项标注自洽**：解析中所有「X对」的集合（或选错型题干下「X错」的集合）必须等于 `answer`。')
w('3. **违禁文案拦截**：出现「题目指定」「请以教材为准」「但原答案为」「原官方参考答案为」「存在争议」「不严谨」即标记为待重生成。')
w('4. **覆盖率校验**：解析必须逐项点评到**所有选项**（含答案项），缺失即拦截（对应 C 类）。')
w('5. **文本相似度校验**：解析与题干+选项的 2-gram 重合率低于阈值（建议 0.06）时，判定解析错配。')
w('')
w('### 6.3 复现方式')
w('')
w('```bash')
w('python scan_all_banks.py      # 全库扫描 -> _allbank_conflicts.json')
w('python gen_allbank_report.py  # 生成本报告 + 全量 CSV 清单')
w('```')
w('')
w('脚本口径（答案抽取优先级）：')
w('')
w('1. 「（X错，为本题正确答案）」「故X为本题正确答案」——最强信号；')
w('2. 「## 正确答案」段、「正确答案：X」行内写法、「故选X/故答X」结论句；')
w('3. 逐项标注「（A对）B错」——单选题取**唯一**被标「对」（或选错型题干下唯一被标「错」）的选项；多选题取「对」集合或「其余全选」；')
w('4. 以上都取不到则跳过（本次共 %.0f%% 的解析因纯叙述性文本无法抽取，已跳过）。' % (18298 / 82136 * 100))
w('')

p = os.path.join(ROOT, '文档', '全题库_解析未同步（数据BUG）排查报告.md')
os.makedirs(os.path.dirname(p), exist_ok=True)
open(p, 'w', encoding='utf-8').write('\n'.join(out))
print('written', p, len(out), 'lines')

csvp = os.path.join(ROOT, '文档', '全题库_解析未同步_问题清单.csv')
with open(csvp, 'w', encoding='utf-8-sig', newline='') as f:
    wr = csv.writer(f)
    wr.writerow(['级别', '年级', '科目', '章节', '题目ID', '题干', '选项', '题库标答', '解析给出的答案',
                 '证据强度', '倾向', '解析原文摘录'])
    for r in sorted(rows, key=lambda x: (x['_gi'], x['subj'], x['level'])):
        wr.writerow([LVLNAME.get(r['level'], r['level']), r['grade'], r['subj'], r['chapter'], r['id'],
                     clip(r['q'], 500), ' / '.join('%s. %s' % (k, v) for k, v in (r.get('o') or {}).items()),
                     r['a'], r['declared'], r.get('how'), TENDENCY.get(r.get('how'), ''), evidence(r)])
print('written', csvp)
