# -*- coding: utf-8 -*-
"""按「已确认题库答案错误_总清单.csv」修正题源数据题库答案（内容级人工确认，安全）。

与早先的字母级脚本不同：本清单是逐条内容核对后确认的真错，`建议改为` 即正确选项。
用法：
  python fix_confirmed_errors.py            # dry-run 预览（默认）
  python fix_confirmed_errors.py --apply    # 落盘（自动备份 + changelog）
  python fix_confirmed_errors.py --rollback # 回滚
"""
import csv, json, os, re, glob, shutil, collections, datetime, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '题源数据')
CSVF = os.path.join(ROOT, '文档', '已确认题库答案错误_总清单.csv')
CHANGELOG = os.path.join(ROOT, '_confirmed_fix_changelog.json')


def norm(s):
    return re.sub(r'[^A-H]', '', str(s or '').upper())


def new_answer(orig, target):
    t = sorted(set(target))
    if len(t) == 1:
        return t[0]
    sep = ''
    for d in [',', '、', '/', '；', ';', ' ']:
        if d in (orig or ''):
            sep = d
            break
    return sep.join(t)


def locate_index():
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
        log = json.load(open(CHANGELOG, encoding='utf-8'))
        n = 0
        for rec in log:
            d = json.load(open(rec['file'], encoding='utf-8'))
            for q in d:
                if isinstance(q, dict) and q.get('id') == rec['id']:
                    q['answer'] = rec['old_answer']
            json.dump(d, open(rec['file'], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            n += 1
        print(f'已回滚 {n} 条 -> {CHANGELOG}')
        return

    rows = list(csv.reader(open(CSVF, encoding='utf-8-sig')))[1:]
    idx = locate_index()
    plan, skip = [], []
    for r in rows:
        src, grade, subj, q, old, new, qid = r[0], r[1], r[2], r[3], r[4], r[5], r[6]
        tgt = norm(new)
        if not tgt:
            skip.append((qid, '建议改为为空')); continue
        locs = idx.get((grade, subj), {}).get(qid)
        if not locs:
            skip.append((qid, f'题源数据未找到(可能属site/data):{grade}/{subj}')); continue
        for fp, i in locs:
            d = json.load(open(fp, encoding='utf-8'))
            qobj = d[i]
            opts = set((qobj.get('options') or qobj.get('o') or {}).keys())
            if set(tgt) - opts:
                skip.append((qid, f'建议字母{tgt}不在选项中{sorted(opts)}')); break
            orig = qobj.get('answer') or qobj.get('a') or ''
            na = new_answer(orig, tgt)
            if norm(orig) == norm(na):
                continue
            plan.append(dict(file=fp, id=qid, grade=grade, subj=subj, old=orig, new=na))
    print(f'清单 {len(rows)} 条 -> 可修正 {len(plan)}，跳过 {len(skip)}')
    for s in skip[:15]:
        print('  跳过', s)
    if mode != 'apply':
        print('(dry-run) 示例：')
        for p in plan[:10]:
            print('   ', p['grade'], p['subj'], p['id'][:12], p['old'], '->', p['new'])
        print('加 --apply 落盘')
        return
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    byfile = collections.defaultdict(list)
    for p in plan:
        byfile[p['file']].append(p)
    log = {}
    if os.path.exists(CHANGELOG):
        for rec in json.load(open(CHANGELOG, encoding='utf-8')):
            log[(rec['file'], rec['id'])] = rec
    for fp, items in byfile.items():
        need = {p['id']: p for p in items}
        d = json.load(open(fp, encoding='utf-8'))
        ch = 0
        for q in d:
            p = need.get(q.get('id')) if isinstance(q, dict) else None
            if not p:
                continue
            cur = q.get('answer') or ''
            if norm(cur) != norm(p['new']):
                log.setdefault((fp, q['id']), dict(file=fp, id=q['id'], old_answer=cur, new_answer=p['new']))
                q['answer'] = p['new']; ch += 1
        if ch:
            if not glob.glob(fp + '.bak*'):
                shutil.copy2(fp, fp + '.bak' + ts)
            json.dump(d, open(fp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(list(log.values()), open(CHANGELOG, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'已应用 {len(log)} 条；备份前缀 .bak{ts}；changelog -> {CHANGELOG}')


if __name__ == '__main__':
    main()
