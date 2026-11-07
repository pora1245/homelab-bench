#!/usr/bin/env python3
"""Offline, deterministic screening selection. Inputs and outputs stay private.

No model requests, scoring mutations, credentials, or original-record writes.
Bundles retain source task IDs; install as reviewed local datasets, not uploads
that impersonate an official benchmark. These are diagnostic, not release packs.
"""
import argparse
import collections
import copy
import gzip
import hashlib
import json
from pathlib import Path


def read(path):
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as f:
        return json.load(f)


def rank(item):
    return hashlib.sha256(('screening-v1:' + item['task']['id']).encode()).hexdigest()


def stratified(items, limit):
    groups = collections.defaultdict(list)
    for item in items:
        t = item['task']
        m = t.get('meta') or {}
        key = (t['scorer'], str(m.get('category', '')), str(m.get('level', '')))
        groups[key].append(item)
    for values in groups.values():
        values.sort(key=rank)
    selected = []
    while groups and len(selected) < limit:
        for key in sorted(list(groups)):
            selected.append(groups[key].pop(0))
            if not groups[key]:
                del groups[key]
            if len(selected) == limit:
                break
    return selected


def same_task(left, right):
    # A matching source ID alone is insufficient when prompts, limits, or
    # official grading metadata have changed between installations.
    return all(left.get(key) == right.get(key) for key in
               ('id', 'prompt', 'answer', 'scorer', 'meta', 'max_tokens'))


def valid_answer(item):
    if not item or item['status'] != 'done' or not item['attempts']:
        return False
    answer = item['attempts'][-1]
    score = answer.get('score') or {}
    return (not answer.get('error') and answer.get('finish_reason') != 'length'
            and score.get('state') == 'scored'
            and (score.get('extra') or {}).get('extraction_method')
            != 'missing_explicit_marker')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--deepseek', required=True, type=Path)
    ap.add_argument('--qwen', required=True, type=Path)
    ap.add_argument('--bbh-audit', required=True, type=Path)
    ap.add_argument('--output', required=True, type=Path)
    args = ap.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    deep, qwen = read(args.deepseek), read(args.qwen)
    qm = {x['task']['id']: x for x in qwen}
    audit = {x['id']: x for x in read(args.bbh_audit)['rows']}
    groups = collections.defaultdict(list)
    comparable = []
    for x in deep:
        t = x['task']
        if t['scorer'] == 'experience':
            continue
        a = x['attempts'][-1]
        score = a.get('score') or {}
        row = audit.get(t['id'])
        val = row['new_value'] if row else score.get('value')
        state = row['new_state'] if row else score.get('state')
        if a.get('error') or state != 'scored':
            groups['invalid_or_unavailable'].append(x)
            continue
        if a.get('finish_reason') == 'length':
            groups['length_retry'].append(x)
            continue
        if row and row['extraction_method'] == 'missing_explicit_marker':
            groups['extraction_review'].append(x)
            continue
        if val == 0:
            groups['normal_wrong'].append(x)
        elif val == 1:
            groups['normal_correct'].append(x)
            m = t.get('meta') or {}
            hard = (t['scorer'] == 'math' and int(m.get('level', 0)) >= 4
                    or t['scorer'] == 'ifeval' and len(m.get('instruction_id_list', [])) >= 2
                    or 'logical_deduction_seven_objects' in t['id']
                    or 'tracking_shuffled_objects_seven_objects' in t['id'])
            if hard:
                groups['complex_correct'].append(x)
        y = qm.get(t['id'])
        if not valid_answer(y):
            continue
        ya = y['attempts'][-1]
        ys = ya.get('score') or {}
        if (ya.get('error') or ya.get('finish_reason') == 'length'
                or ys.get('state') != 'scored'
                or not same_task(t, y['task'])):
            continue
        # BBH comparison requires both records to use the same updated grader.
        if row and ys.get('scorer_version') != 'bbh-marker-exact-v5':
            continue
        if not row and score.get('scorer_version') != ys.get('scorer_version'):
            continue
        comparable.append(x)
        if (val == 1) != (ys.get('value') == 1):
            groups['discordant'].append(x)

    # Finite first screening wave. Reused answers need no new inference.
    selected = {}
    for role, limit in [('discordant', 200), ('normal_wrong', 192),
                        ('complex_correct', 64), ('normal_correct', 48)]:
        for x in stratified(groups[role], limit):
            selected.setdefault(x['task']['id'], {'item': x, 'roles': []})['roles'].append(role)
    reusable, pending, quarantine = [], [], []
    for tid, row in selected.items():
        y = qm.get(tid)
        if y and y['status'] == 'done' and y['attempts']:
            a = y['attempts'][-1]
            expected = ('bbh-marker-exact-v5' if row['item']['task']['scorer'] == 'bbh'
                        else (row['item']['attempts'][-1].get('score') or {}).get('scorer_version'))
            if (not valid_answer(y) or not same_task(row['item']['task'], y['task'])
                    or (a.get('score') or {}).get('scorer_version') != expected):
                quarantine.append(row)
            else:
                reusable.append(row)
        else:
            pending.append(row)

    def pack(name, title, items, expand=False):
        tasks = []
        for x in items:
            t = copy.deepcopy(x['task'])
            if expand:
                t['max_tokens'] = 2 * min(8192, t['max_tokens'])
            tasks.append(t)
        data = {'id': name, 'name': title, 'version': '2026-11-08.1',
                'sources': {'selection': 'diagnostic-only', 'official_full_score': False,
                            'source_task_ids_preserved': True, 'seed': 'screening-v1',
                            'source_count': len(tasks), 'installed_count': len(tasks),
                            'reasoning': ('DeepSeek default high verified; explicit high on retry'
                                          if expand else
                                          'Qwen template default xhigh verified; explicit xhigh preserves baseline')},
                'tasks': tasks}
        (args.output / (name + '.json')).write_text(json.dumps(data, ensure_ascii=False))

    # Two per scorer where available, round robin across source categories.
    pilot = []
    for scorer in sorted({x['task']['scorer'] for x in groups['length_retry']}):
        pilot.extend(stratified([x for x in groups['length_retry']
                                 if x['task']['scorer'] == scorer], 2))
    ids = {x['task']['id'] for x in pilot}
    remainder = [x for x in groups['length_retry'] if x['task']['id'] not in ids]
    pack('diagnostic-length-pilot-v1', '출력 한도 확대 · 사전 확인', pilot, True)
    pack('diagnostic-length-remainder-v1', '출력 한도 확대 · 나머지 문항', remainder, True)
    if pending:
        pack('diagnostic-screening-wave1-v1', '분별 후보 · 미측정 문항 1차', [r['item'] for r in pending])
    manifest = {'version': 1, 'diagnostic_only': True,
                'group_counts': {k: len(v) for k, v in groups.items()},
                'groups': {k: [x['task']['id'] for x in v] for k, v in groups.items()},
                'pilot_count': len(pilot), 'remainder_count': len(remainder),
                'screening_selected': len(selected), 'qwen_reusable': len(reusable),
                'qwen_pending': len(pending), 'qwen_review': len(quarantine),
                'selected_roles': {k: v['roles'] for k, v in selected.items()},
                'input_hashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in [args.deepseek, args.qwen, args.bbh_audit]}}
    (args.output / 'selection-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({k: v for k, v in manifest.items()
                      if k not in ['groups', 'selected_roles', 'input_hashes']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
