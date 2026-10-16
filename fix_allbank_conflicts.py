# -*- coding: utf-8 -*-
"""题源数据「解析未同步」铁证补丁脚本。

针对 _allbank_conflicts.json 中：
    level ∈ {A, A-} 且 how ∈ {mark, decl}
的条目（即「解析明写 为本题正确答案」或「## 正确答案 / 故选X」铁证，题库答案与解析矛盾），
将题源数据题目文件中的 question['answer'] 修正为解析给出的答案 (declared)。

特点：
  - 默认 --dry-run：只计算并打印变更计划，写入 _allbank_fix_plan.csv，不改动任何文件。
  - --apply：先对每个被改文件做备份（<file>.bak<YYYYMMDD-HHMMSS>），再落盘，并写
            _allbank_fix_changelog.json 供回滚。
  - --rollback：读取 changelog，把 answer 还原为旧值。

用法：
  python fix_allbank_conflicts.py                 # dry-run 预览
  python fix_allbank_conflicts.py --apply         # 真实落盘（先自动备份）
  python fix_allbank_conflicts.py --rollback      # 回滚
"""
import json, re, os, sys, glob, shutil, collections, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '题源数据')
CONF = os.path.join(ROOT, '_allbank_conflicts.json')
PLAN = os.path.join(ROOT, '_allbank_fix_plan.csv')
CHANGELOG = os.path.join(ROOT, '_allbank_fix_changelog.json')

STRONG = {'mark', 'decl'}


def norm(s):
    return re.sub(r'[^A-H]', '', str(s or '').upper())


def new_answer(orig, declared_letters):
    """把题库存值改写为 declared 字母集合，尽量保留原分隔符风格。"""
    decl = sorted(declared_letters)
    if len(decl) == 1:
        return decl[0]
    sep = ''
    for d in [',', '、', '/', '；', ';', ' ']:
        if d in (orig or ''):
            sep = d
            break
    return sep.join(decl)


def load_conflicts():
    data = json.load(open(CONF, encoding='utf-8'))
    out = []
    for r in data:
        if r.get('level') in ('A', 'A-') and r.get('how') in STRONG:
            out.append(r)
    return out


def locate_index():
    """返回 {(grade,subj): {qid: [(filepath, idx), ...]}}——同一 id 可能在多个题目文件里重复，
    需全部命中并与扫描器一致（扫描器按文件遍历顺序 last-wins，故统一改所有副本最稳妥）。"""
    idx = collections.defaultdict(lambda: collections.defaultdict(list))
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
                if base.startswith('解析') or '解析对照' in base:
                    continue
                try:
                    d = json.load(open(fp, encoding='utf-8'))
                except Exception:
                    continue
                if isinstance(d, list):
                    for i, q in enumerate(d):
                        if isinstance(q, dict) and q.get('id'):
                            idx[(grade, subj)][q['id']].append((fp, i))
    return idx


def main():
    mode = 'apply' if '--apply' in sys.argv else ('rollback' if '--rollback' in sys.argv else 'dry-run')
    sys.stdout.reconfigure(encoding='utf-8')

    if mode == 'rollback':
        if not os.path.exists(CHANGELOG):
            print('! 无 changelog，无法回滚'); return
        log = json.load(open(CHANGELOG, encoding='utf-8'))
        done = 0
        for rec in log:
            fp, qid, old = rec['file'], rec['id'], rec['old_answer']
            d = json.load(open(fp, encoding='utf-8'))
            for q in d:
                if isinstance(q, dict) and q.get('id') == qid:
                    q['answer'] = old
                    break
            json.dump(d, open(fp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            done += 1
        print(f'已回滚 {done} 条 -> {CHANGELOG}')
        return

    confs = load_conflicts()
    print(f'铁证待修正条目（A/A- 且 how∈{{mark,decl}}）：{len(confs)}')
    idx = locate_index()

    plan = []
    skipped = []
    for r in confs:
        grade, subj, qid = r['grade'], r['subj'], r['id']
        locs = idx.get((grade, subj), {}).get(qid, [])
        if not locs:
            skipped.append((qid, 'locate 失败'))
            continue
        declared = set(norm(r['declared']))
        if not declared:
            skipped.append((qid, 'declared 为空'))
            continue
        changed = 0
        for fp, i in locs:
            d = json.load(open(fp, encoding='utf-8'))
            q = d[i]
            opts = set((q.get('options') or q.get('o') or {}).keys())
            if declared - opts:
                skipped.append((qid, f'declared 含非选项字母 {sorted(declared - opts)}'))
                break
            orig = q.get('answer') or q.get('a') or ''
            new = new_answer(orig, declared)
            if norm(orig) == norm(new):
                continue
            plan.append(dict(file=fp, id=qid, chapter=r.get('chapter', ''),
                             q=r.get('q', '')[:60], old_answer=orig, new_answer=new,
                             declared=r['declared'], how=r['how'], level=r['level'],
                             subj=subj, grade=grade))
            changed += 1
        else:
            if changed == 0:
                skipped.append((qid, 'answer 已一致(无需改)'))

    print(f'可修正：{len(plan)}  跳过：{len(skipped)}')
    for s in skipped[:20]:
        print('  跳过', s)

    # 写 plan csv（utf-8-sig）
    with open(PLAN, 'w', encoding='utf-8-sig') as f:
        f.write('年级,科目,章节,题目ID,题干前60,题库原答案,解析正确答案,新答案,how,level,源文件\n')
        for p in plan:
            f.write(','.join(str(p[k]) for k in
                   ['grade', 'subj', 'chapter', 'id', 'q', 'old_answer', 'declared', 'new_answer', 'how', 'level', 'file']) + '\n')
    print('计划已写', PLAN)

    if mode != 'apply':
        print('（dry-run，未改动任何文件。加 --apply 以真实落盘）')
        return

    # ---- apply ----
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    by_file = collections.defaultdict(list)
    for p in plan:
        by_file[p['file']].append(p)
    log = {}
    if os.path.exists(CHANGELOG):
        for rec in json.load(open(CHANGELOG, encoding='utf-8')):
            log[(rec['file'], rec['id'])] = rec          # 保留最早的真实旧值，便于回滚
    for fp, items in by_file.items():
        need = {p['id']: p for p in items}
        d = json.load(open(fp, encoding='utf-8'))
        changed = 0
        for q in d:
            p = need.get(q.get('id'))
            if not isinstance(q, dict) or p is None:
                continue
            cur = q.get('answer') or ''
            if norm(cur) != norm(p['new_answer']):
                log.setdefault((fp, q['id']), dict(file=fp, id=q['id'],
                              old_answer=cur, new_answer=p['new_answer']))
                q['answer'] = p['new_answer']
                changed += 1
        if changed:
            if not glob.glob(fp + '.bak*'):
                shutil.copy2(fp, fp + '.bak' + ts)
            json.dump(d, open(fp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(list(log.values()), open(CHANGELOG, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'本次 plan {len(plan)} 条；累计 changelog {len(log)} 条 -> {CHANGELOG}')


if __name__ == '__main__':
    main()
