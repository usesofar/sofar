#!/usr/bin/env python3
"""Offline replays for r4-fixes A2 and A4 (R4-RESEARCH 2.2, self-improve D16): round 4's
sofar sessions re-run through two engines on the same reconstructed record state.

Every session is replayed on a scratch clone of its cell's repo at `bench: after S<n-1>` —
the record a session started from — under a scratch HOME/XDG, through
  old  sofar.sh 0.34.1 as npm installs it (--old-prefix: dist/cli.js + @sofar.sh/core-*)
  new  this checkout (packages/engine/dist/cli.js + target/release/sofar-core)
Nothing under the bench cells is ever written: commands read from transcripts run only in
the scratch clone, only when every segment is a read-only program (see SAFE).

  python3 r4-replay.py a2-codex   Codex startup context per session: AGENTS.md block,
                                  sofar-write skill listing, digest, prompt block
  python3 r4-replay.py a4-notices PostToolUse notices: chars, and the share that repeat
                                  only ids already told (notice_dupes.py's metric)
  python3 r4-replay.py a4-store   Claude store reads (raw .sofar reads and `sofar` reads)
                                  through each engine's rewrite and views
  python3 r4-replay.py a4-recall  the recall block: chars, ids, ids the digest holds,
                                  and ids the session later cites

Data: --cells (default /Users/Shared/bench-cells/boopada) and --scripts, the r4-research
lane's scripts dir (claude_sessions.py, codex_sessions.py), which locate transcripts.
The bench text never leaves the scratch dir; the script prints counts only.
"""
import argparse
import concurrent.futures as cf
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
IDRE = re.compile(r"\[(?:[a-z0-9-]+ )?(D\d+|M\d+)(?:·[0-9a-z]{4})?\]")
CODEX_S = [9, 10, 11, 25, 26, 27]
CLAUDE_S = [*range(1, 9), *range(12, 15), *range(21, 25), *range(28, 31)]  # main-repo sessions


def args_parser():
    p = argparse.ArgumentParser()
    p.add_argument('what', choices=['a2-codex', 'a4-notices', 'a4-store', 'a4-recall'])
    p.add_argument('--cells', default='/Users/Shared/bench-cells/boopada')
    p.add_argument('--scripts', default=os.path.expanduser('~/IO/handoff-bench/scenario5-launch-bench/analysis/r4-research/scripts'))
    p.add_argument('--old-prefix', required=True, help='npm prefix holding sofar.sh@0.34.1')
    p.add_argument('--scratch', default=None)
    p.add_argument('--reps', default='1,2,3')
    p.add_argument('--jobs', type=int, default=4)
    p.add_argument('--json', default=None)
    p.add_argument('--state', choices=['start', 'end'], default='start',
                   help="a4-notices: the record and tree at the session's start, or at its end (files and rules it made exist from the first call)")
    return p


A = None


def engines():
    old_core = glob.glob(os.path.join(A.old_prefix, 'node_modules', '@sofar.sh', 'core-*', 'sofar-core'))
    return {
        'old': {'cli': os.path.join(A.old_prefix, 'node_modules', 'sofar.sh', 'dist', 'cli.js'), 'core': old_core[0] if old_core else None},
        'new': {'cli': os.path.join(REPO, 'packages', 'engine', 'dist', 'cli.js'), 'core': os.path.join(REPO, 'target', 'release', 'sofar-core')},
    }


def cell(rep):
    return os.path.join(A.cells, f'round-4-sofar-r{rep}', 'sofar', f'r{rep}')


def clone_at(rep, n, dest, end=False):
    """The cell repo at `bench: after S<n-1>` (the first commit for S1), in dest; `bench: after S<n>` when end."""
    if end:
        n += 1
    src = os.path.join(cell(rep), 'repo')
    subprocess.run(['git', 'clone', '-q', '--no-hardlinks', src, dest], check=True)
    if n > 1:
        sha = subprocess.run(['git', '-C', dest, 'log', '--format=%H', f'--grep=^bench: after S{n - 1}$'], capture_output=True, text=True).stdout.split()
        if not sha:  # S16 follows S15's worktree commits; fall back to the nearest earlier one
            for k in range(n - 2, 0, -1):
                sha = subprocess.run(['git', '-C', dest, 'log', '--format=%H', f'--grep=^bench: after S{k}$'], capture_output=True, text=True).stdout.split()
                if sha:
                    break
    else:
        sha = subprocess.run(['git', '-C', dest, 'rev-list', '--max-parents=0', 'HEAD'], capture_output=True, text=True).stdout.split()
    subprocess.run(['git', '-C', dest, 'checkout', '-q', sha[0]], check=True)
    subprocess.run(['git', '-C', dest, 'checkout', '-q', '-B', 'main'], check=True)
    return dest


def env_for(home, engine, extra=None):
    bindir = os.path.join(home, 'bin')
    os.makedirs(bindir, exist_ok=True)
    shim = os.path.join(bindir, 'sofar')
    with open(shim, 'w') as f:
        f.write(f'#!/bin/sh\nexec node "{engine["cli"]}" "$@"\n')
    os.chmod(shim, 0o755)
    e = {
        'PATH': f'{bindir}:/usr/bin:/bin:/usr/sbin:/sbin:{os.path.dirname(shutil.which("node"))}',
        'HOME': home,
        'XDG_STATE_HOME': os.path.join(home, 'state'),
        'XDG_CONFIG_HOME': os.path.join(home, 'config'),
        'XDG_DATA_HOME': os.path.join(home, 'data'),
        'SOFAR_NO_UPDATE_CHECK': '1',
        'LANG': 'en_US.UTF-8',
        'TZ': 'UTC',
        'SOFAR_CORE': '0',
    }
    e.update(extra or {})
    return e


def hook(engine, sub, payload, cwd, env, host=None, native=False):
    if native and engine['core'] and host is None:
        cmd = [engine['core'], 'event', sub]
    else:
        cmd = ['node', engine['cli'], 'event', sub] + (['--host', host] if host else [])
    r = subprocess.run(cmd, input=json.dumps(payload), capture_output=True, text=True, cwd=cwd, env=env, timeout=120)
    return r.stdout


def context_of(stdout):
    t = stdout.strip()
    if not t:
        return ''
    try:
        d = json.loads(t)
    except Exception:
        return t
    spec = d.get('hookSpecificOutput') if isinstance(d, dict) else None
    if isinstance(spec, dict) and isinstance(spec.get('additionalContext'), str):
        return spec['additionalContext']
    return ''


def pool(fn, items):
    with cf.ThreadPoolExecutor(max_workers=A.jobs) as ex:
        return list(ex.map(fn, items))


# ---------------------------------------------------------------------------
# A2: Codex startup context.
# ---------------------------------------------------------------------------

def codex_rollout(rep, n):
    import codex_sessions as xs
    cd = cell(rep)
    rolls = {os.path.basename(f)[-42:-6]: f for f in glob.glob(os.path.join(cd, 'codex-home', 'sessions', '**', 'rollout-*.jsonl'), recursive=True)}
    tid = xs.thread_id(os.path.join(cd, 'artifacts', f'S{n}', 'agent.stdout'))
    return tid, rolls.get(tid)


def codex_start(rollout):
    import codex_sessions as xs
    start, agents = Counter(), ''
    for line in open(rollout, errors='replace'):
        e = json.loads(line)
        p = e.get('payload') or {}
        if e.get('type') != 'response_item' or p.get('type') != 'message':
            if p.get('type') in ('function_call', 'custom_tool_call'):
                break
            continue
        if p.get('role') == 'assistant':
            break
        txt = ''.join(c.get('text', '') for c in p.get('content', []) if isinstance(c, dict))
        k = xs.classify_start(p.get('role'), txt)
        start[k] += len(txt)
        if k == 'agents_md':
            agents = txt
    return start, agents


def thin_block_and_skill(engine):
    """What `sofar init --agents codex` writes in a fresh repo: the AGENTS.md block and the skill's listing line."""
    d = tempfile.mkdtemp(dir=A.scratch)
    subprocess.run(['git', 'init', '-q', '-b', 'main', d], check=True)
    home = os.path.join(d, '.home')
    env = env_for(home, engine)
    subprocess.run(['node', engine['cli'], 'init', '--agents', 'codex', '--root', d], capture_output=True, env=env, cwd=d)
    block = open(os.path.join(d, 'AGENTS.md')).read()
    s, e = block.find('<!-- sofar:protocol -->'), block.find('<!-- /sofar:protocol -->')
    skill = os.path.join(d, '.agents', 'skills', 'sofar-write', 'SKILL.md')
    listing = 0
    if os.path.exists(skill):
        desc = re.search(r'^description: (.*)$', open(skill).read(), re.M).group(1)
        # Codex lists a project skill as one root line and one entry line (codex_sessions' skills block).
        listing = len(f'- `r2` = `{d}/.agents/skills`\n') + len(f'- sofar-write: {desc} (file: r2/sofar-write/SKILL.md)\n')
    return block[s:e + len('<!-- /sofar:protocol -->')], listing


def a2_codex():
    eng = engines()
    new_block, new_skill = thin_block_and_skill(eng['new'])
    old_block, _ = thin_block_and_skill(eng['old'])
    jobs = [(rep, n) for rep in map(int, A.reps.split(',')) for n in CODEX_S]

    def one(job):
        rep, n = job
        tid, roll = codex_rollout(rep, n)
        if roll is None:
            return None
        start, agents_txt = codex_start(roll)
        prompt = open(os.path.join(cell(rep), 'artifacts', f'S{n}', 'prompt.txt')).read()
        out = {'rep': rep, 'S': n, 'measured': dict(start)}
        # AGENTS.md: the cell's file with its sofar block swapped for the thin one.
        s = agents_txt.find('<!-- sofar:protocol -->')
        e = agents_txt.find('<!-- /sofar:protocol -->')
        span = e + len('<!-- /sofar:protocol -->') - s if s >= 0 and e > s else 0
        out['agents_block_old'] = span
        out['agents_md_new'] = start['agents_md'] - span + len(new_block)
        for name, engine in eng.items():
            work = tempfile.mkdtemp(dir=A.scratch)
            repo = clone_at(rep, n, os.path.join(work, 'repo'))
            env = env_for(os.path.join(work, 'home'), engine)
            payload = {'session_id': tid, 'cwd': repo, 'hook_event_name': 'SessionStart', 'source': 'startup', 'model': 'gpt-5.6-sol'}
            digest = context_of(hook(engine, 'session-start', payload, repo, env, host='codex'))
            ups = context_of(hook(engine, 'user-prompt', {**payload, 'hook_event_name': 'UserPromptSubmit', 'prompt': prompt, 'turn_id': 't1'}, repo, env, host='codex'))
            out[f'digest_{name}'] = len(digest)
            out[f'prompt_block_{name}'] = len(ups)
            shutil.rmtree(work, ignore_errors=True)
        return out

    rows = [r for r in pool(one, jobs) if r is not None]
    tot = Counter()
    for r in rows:
        m = r['measured']
        base = sum(m.values())
        new = (m['skills'] + new_skill + r['agents_md_new'] + r['prompt_block_new'] + r['digest_new']
               + sum(v for k, v in m.items() if k not in ('skills', 'agents_md', 'recall_block', 'sofar_digest')))
        old_replay = (m['skills'] + m['agents_md'] + r['prompt_block_old'] + r['digest_old']
                      + sum(v for k, v in m.items() if k not in ('skills', 'agents_md', 'recall_block', 'sofar_digest')))
        r['start_measured'], r['start_old_replay'], r['start_new'] = base, old_replay, new
        for k in ('start_measured', 'start_old_replay', 'start_new', 'digest_old', 'digest_new', 'prompt_block_old', 'prompt_block_new', 'agents_block_old'):
            tot[k] += r[k]
        tot['measured_digest'] += m.get('sofar_digest', 0)
        tot['measured_recall'] += m.get('recall_block', 0)
        tot['measured_agents'] += m.get('agents_md', 0)
        tot['agents_new'] += r['agents_md_new']
    k = len(rows)
    print(f'a2-codex: {k} sessions; thin block {len(new_block)} chars (0.34.1 block {len(old_block)}); skill listing +{new_skill}')
    for key in ('measured_agents', 'agents_new', 'measured_digest', 'digest_old', 'digest_new', 'measured_recall', 'prompt_block_old', 'prompt_block_new', 'start_measured', 'start_old_replay', 'start_new'):
        print(f'  {key:18} {tot[key] / k:9.0f} per session')
    return {'rows': rows, 'thin_block': len(new_block), 'skill_listing': new_skill}


# ---------------------------------------------------------------------------
# Transcript streams (Claude and Codex), in order.
# ---------------------------------------------------------------------------

def claude_stream(rep, n):
    """[(batch index, tool_name, tool_input, tool_response, tool_use_id)] of the main transcript, and its prompt."""
    import claude_sessions as cs
    cd = cell(rep)
    out = []
    batch = 0
    for sid in cs.session_ids(f'{cd}/artifacts/S{n}/agent.stdout'):
        for p in cs.paths_for(sid, 4, 'sofar', rep):
            if '/subagents/' in p:
                continue
            pend = {}
            for line in open(p):
                e = json.loads(line)
                if e.get('type') == 'assistant':
                    calls = [c for c in (e.get('message') or {}).get('content') or [] if c.get('type') == 'tool_use']
                    if calls:
                        mid = (e.get('message') or {}).get('id')
                        for c in calls:
                            pend[c['id']] = (mid, c['name'], c.get('input') or {})
                elif e.get('type') == 'user':
                    for c in (e.get('message') or {}).get('content') or []:
                        if isinstance(c, dict) and c.get('type') == 'tool_result' and c.get('tool_use_id') in pend:
                            mid, name, inp = pend.pop(c['tool_use_id'])
                            res = e.get('toolUseResult') if isinstance(e.get('toolUseResult'), dict) else {}
                            out.append((mid, name, inp, res, c['tool_use_id'], c.get('content')))
    return out


def codex_stream(rep, n):
    """[(tool name, tool_input)] for every command Codex ran and every file change it made,
    in order, from the rollout's item_completed events: code mode runs commands from inside
    scripts (loops over test files), so the function calls alone do not show them."""
    tid, roll = codex_rollout(rep, n)
    out = []
    if roll is None:
        return tid, out
    for line in open(roll, errors='replace'):
        e = json.loads(line)
        p = e.get('payload') or {}
        if p.get('type') != 'item_completed':
            continue
        it = p.get('item') or {}
        if it.get('type') == 'CommandExecution':
            cmd = it.get('command')
            out.append(('Bash', {'command': cmd[-1] if isinstance(cmd, list) and cmd else str(cmd)}))
        elif it.get('type') == 'FileChange':
            heads = {'add': 'Add File', 'delete': 'Delete File', 'update': 'Update File'}
            lines = ['*** Begin Patch']
            for path, ch in (it.get('changes') or {}).items():
                lines.append(f"*** {heads.get(ch.get('type'), 'Update File')}: {path}")
                if ch.get('move_path'):
                    lines.append(f"*** Move to: {ch['move_path']}")
                lines.append('+x')
            lines.append('*** End Patch')
            out.append(('apply_patch', {'command': '\n'.join(lines) + '\n'}))
    return tid, out


def dupes(notices):
    seen, n, dup, chars, dupchars = set(), 0, 0, 0, 0
    for t in notices:
        ids = IDRE.findall(t)
        n += 1
        chars += len(t)
        if ids and all(i in seen for i in ids):
            dup += 1
            dupchars += len(t)
        seen.update(ids)
    return n, chars, dup, dupchars


def remap(text, rep, repo):
    """Cell paths in a transcript → the scratch clone (worktree paths too: an approximation)."""
    cd = cell(rep)
    for sub in ['repo', 'clone-S12', 'wt-case-pack', 'wt-order-caps', 'wt-pick-path']:
        text = text.replace(os.path.join(cd, sub), repo)
    return text


# ---------------------------------------------------------------------------
# A4: notices.
# ---------------------------------------------------------------------------

def a4_notices():
    eng = engines()
    jobs = [('codex', rep, n) for rep in map(int, A.reps.split(',')) for n in CODEX_S]
    jobs += [('claude', rep, n) for rep in map(int, A.reps.split(',')) for n in CLAUDE_S]

    def one(job):
        agent, rep, n = job
        if agent == 'codex':
            _, stream = codex_stream(rep, n)
            if not stream:
                return None
            # A fresh id: at the end state the record holds this session's own
            # touches, and the last-touch test would read the replay's edits as old.
            tid = f'replay-{rep}-{n}-0000-0000-000000000000'
        else:
            stream = claude_stream(rep, n)
            tid = f'replay-{rep}-{n}-0000-0000-000000000000'
        prompt = open(os.path.join(cell(rep), 'artifacts', f'S{n}', 'prompt.txt')).read()
        res = {'agent': agent, 'rep': rep, 'S': n}
        for name, engine in eng.items():
            work = tempfile.mkdtemp(dir=A.scratch)
            repo = clone_at(rep, n, os.path.join(work, 'repo'), end=A.state == 'end')
            env = env_for(os.path.join(work, 'home'), engine)
            host = 'codex' if agent == 'codex' else None
            base = {'session_id': tid, 'cwd': repo}
            hook(engine, 'session-start', {**base, 'hook_event_name': 'SessionStart', 'source': 'startup'}, repo, env, host=host, native=True)
            hook(engine, 'user-prompt', {**base, 'hook_event_name': 'UserPromptSubmit', 'prompt': prompt}, repo, env, host=host, native=True)
            notices = []
            if agent == 'codex':
                for tool, inp in stream:
                    payload = {**base, 'hook_event_name': 'PostToolUse', 'tool_name': tool, 'tool_input': {k: remap(v, rep, repo) for k, v in inp.items()}, 'tool_response': ''}
                    ctx = context_of(hook(engine, 'post-tool', payload, repo, env, host='codex'))
                    if ctx:
                        notices.append(ctx)
            else:
                batches = {}
                for mid, tool, inp, resp, tuid, _ in stream:
                    batches.setdefault(mid, []).append((tool, inp, resp, tuid))
                for mid, calls in batches.items():
                    items = []
                    for tool, inp, resp, tuid in calls:
                        if tool not in ('Edit', 'Write', 'MultiEdit', 'Bash', 'Read', 'Grep'):
                            continue
                        inp2 = json.loads(remap(json.dumps(inp), rep, repo))
                        resp2 = json.loads(remap(json.dumps(resp), rep, repo)) if isinstance(resp, dict) else {}
                        items.append({'tool_name': tool, 'tool_input': inp2, 'tool_response': resp2, 'tool_use_id': tuid})
                    for it in items:
                        ctx = context_of(hook(engine, 'post-tool', {**base, 'hook_event_name': 'PostToolUse', **it}, repo, env, native=True))
                        if ctx:
                            notices.append(ctx)
                    if name == 'new' and items:
                        ctx = context_of(hook(engine, 'post-tool-batch', {**base, 'hook_event_name': 'PostToolBatch', 'tool_calls': items}, repo, env, native=True))
                        if ctx:
                            notices.append(ctx)
            res[name] = dupes(notices)
            shutil.rmtree(work, ignore_errors=True)
        return res

    rows = [r for r in pool(one, jobs) if r is not None]
    summary = {}
    for agent in ('claude', 'codex'):
        rs = [r for r in rows if r['agent'] == agent]
        if not rs:
            continue
        for name in ('old', 'new'):
            n = sum(r[name][0] for r in rs)
            ch = sum(r[name][1] for r in rs)
            d = sum(r[name][2] for r in rs)
            dc = sum(r[name][3] for r in rs)
            summary[f'{agent}_{name}'] = {'sessions': len(rs), 'notices': n, 'chars': ch, 'repeats': d, 'repeat_chars': dc}
            print(f'a4-notices {agent:6} {name}: {len(rs)} sessions, {n / len(rs):.1f} notices/session, {ch / len(rs):.0f} chars/session, repeats {d}/{n} ({d / max(n, 1):.0%})')
        o, nw = summary[f'{agent}_old'], summary[f'{agent}_new']
        print(f'  {agent}: notice chars {nw["chars"] / max(o["chars"], 1) - 1:+.0%}')
    return {'rows': rows, 'summary': summary}


# ---------------------------------------------------------------------------
# A4: store reads (Claude).
# ---------------------------------------------------------------------------

SAFE = re.compile(r'^(cat|head|tail|sed|grep|egrep|rg|ls|wc|echo|nl|sort|uniq|cut|tr|awk|sofar (read|show|status|find)|true|printf)\b')


def safe(cmd):
    """Every segment a read-only program (sed without -i, find/awk refused, no redirection into a file)."""
    if re.search(r'(^|[^2&])>|\bsed\s+-i|`|\$\(|\btee\b|\brm\b|\bmv\b|\bgit\b|\bbun\b|\bnpm\b|\bnode\b|\bfor\b|\bwhile\b|system\(', cmd):
        return False
    for seg in re.split(r'&&|\|\||;|\||\n', cmd):
        seg = seg.strip()
        if not seg or seg.startswith('cd '):
            continue
        if not SAFE.match(seg):
            return False
    return True


def a4_store():
    import claude_sessions as cs
    eng = engines()
    jobs = [(rep, n) for rep in map(int, A.reps.split(',')) for n in CLAUDE_S]

    def one(job):
        rep, n = job
        stream = claude_stream(rep, n)
        calls = []
        for mid, tool, inp, resp, tuid, content in stream:
            k = cs.kind_of(tool, inp, 'sofar')
            if tool == 'Bash' and (k == 'raw_store_read' or k in ('sofar_cli:show', 'sofar_cli:status', 'sofar_cli:read', 'sofar_cli:find')):
                calls.append((inp.get('command', ''), cs.clen(content)))
        if not calls:
            return None
        tid = f'replay-{rep}-{n}-0000-0000-000000000000'
        prompt = open(os.path.join(cell(rep), 'artifacts', f'S{n}', 'prompt.txt')).read()
        res = {'rep': rep, 'S': n, 'calls': len(calls), 'measured': sum(c for _, c in calls)}
        for name, engine in eng.items():
            work = tempfile.mkdtemp(dir=A.scratch)
            repo = clone_at(rep, n, os.path.join(work, 'repo'))
            env = env_for(os.path.join(work, 'home'), engine)
            base = {'session_id': tid, 'cwd': repo}
            hook(engine, 'session-start', {**base, 'hook_event_name': 'SessionStart', 'source': 'startup'}, repo, env, native=True)
            hook(engine, 'user-prompt', {**base, 'hook_event_name': 'UserPromptSubmit', 'prompt': prompt}, repo, env, native=True)
            total = store = replayed = measured = 0
            for cmd, chars in calls:
                cmd = remap(cmd, rep, repo)
                if not safe(cmd):
                    continue

                def run(command):
                    out = hook(engine, 'pre-tool', {**base, 'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_input': {'command': command}}, repo, env, native=True)
                    final = json.loads(out)['hookSpecificOutput']['updatedInput']['command'] if out.strip() else command
                    r = subprocess.run(['sh', '-c', final], capture_output=True, text=True, cwd=repo, env=env, timeout=60)
                    return len(r.stdout) + len(r.stderr)

                total += run(cmd)
                # The store's own part: only the pipelines that read the record (and the cd's before them).
                only = '; '.join(p for p in re.split(r'&&|\|\||;|\n', cmd) if p.strip().startswith('cd ') or '.sofar' in p or re.match(r'\s*sofar\s', p))
                store += run(only) if only.strip() else 0
                replayed += 1
                measured += chars
            res[name] = total
            res[f'{name}_store'] = store
            res['replayed'] = replayed
            res['replayed_measured'] = measured
            shutil.rmtree(work, ignore_errors=True)
        return res

    rows = [r for r in pool(one, jobs) if r is not None]
    calls = sum(r['calls'] for r in rows)
    rep_calls = sum(r['replayed'] for r in rows)
    old, new = sum(r['old'] for r in rows), sum(r['new'] for r in rows)
    meas, rmeas = sum(r['measured'] for r in rows), sum(r['replayed_measured'] for r in rows)
    print(f'a4-store: {len(rows)} sessions, {rep_calls}/{calls} store calls replayed (read-only); round-4 chars of those {rmeas} (all {meas})')
    print(f'  replayed chars: 0.34.1 {old}, new {new}  → new/old {new / max(old, 1):.0%}; new/round-4 {new / max(rmeas, 1):.0%}')
    so, sn = sum(r['old_store'] for r in rows), sum(r['new_store'] for r in rows)
    print(f'  the record\'s own part (store pipelines only): 0.34.1 {so}, new {sn} → new/old {sn / max(so, 1):.0%}')
    return {'rows': rows}


# ---------------------------------------------------------------------------
# A4: recall.
# ---------------------------------------------------------------------------

def a4_recall():
    eng = engines()
    jobs = [('claude', rep, n) for rep in map(int, A.reps.split(',')) for n in CLAUDE_S]
    jobs += [('codex', rep, n) for rep in map(int, A.reps.split(',')) for n in CODEX_S]

    def one(job):
        agent, rep, n = job
        if agent == 'codex':
            tid, roll = codex_rollout(rep, n)
            if roll is None:
                return None
            later = []
            for line in open(roll, errors='replace'):
                e = json.loads(line)
                p = e.get('payload') or {}
                if e.get('type') == 'response_item' and p.get('type') == 'message' and p.get('role') == 'assistant':
                    later.append(''.join(c.get('text', '') for c in p.get('content', []) if isinstance(c, dict)))
                elif e.get('type') == 'response_item' and p.get('type') in ('function_call', 'custom_tool_call'):
                    later.append(p.get('arguments') or p.get('input') or '')
            later = '\n'.join(later)
        else:
            tid = f'replay-{rep}-{n}-0000-0000-000000000000'
            later = '\n'.join(json.dumps(inp) for _, _, inp, _, _, _ in claude_stream(rep, n))
        prompt = open(os.path.join(cell(rep), 'artifacts', f'S{n}', 'prompt.txt')).read()
        res = {'agent': agent, 'rep': rep, 'S': n}
        for name, engine in eng.items():
            work = tempfile.mkdtemp(dir=A.scratch)
            repo = clone_at(rep, n, os.path.join(work, 'repo'))
            env = env_for(os.path.join(work, 'home'), engine)
            host = 'codex' if agent == 'codex' else None
            base = {'session_id': tid, 'cwd': repo}
            digest = context_of(hook(engine, 'session-start', {**base, 'hook_event_name': 'SessionStart', 'source': 'startup'}, repo, env, host=host, native=True))
            ups = context_of(hook(engine, 'user-prompt', {**base, 'hook_event_name': 'UserPromptSubmit', 'prompt': prompt}, repo, env, host=host, native=True))
            i = ups.find('sofar: what this record holds')
            block = ups[i:].split('\nsofar: this prompt is P')[0] if i >= 0 else ''
            ids = list(dict.fromkeys(IDRE.findall(block)))
            dig = set(re.findall(r'\b(D\d+|M\d+)\b', digest))
            cited = [x for x in ids if re.search(rf'\b{x}\b', later)]
            res[name] = {'chars': len(block), 'ids': len(ids), 'in_digest': len([x for x in ids if x in dig]), 'cited': len(cited)}
            shutil.rmtree(work, ignore_errors=True)
        return res

    rows = [r for r in pool(one, jobs) if r is not None]
    for agent in ('claude', 'codex'):
        rs = [r for r in rows if r['agent'] == agent]
        for name in ('old', 'new'):
            blocks = [r[name] for r in rs if r[name]['ids'] > 0]
            ids = sum(b['ids'] for b in blocks)
            print(f'a4-recall {agent:6} {name}: {len(blocks)}/{len(rs)} blocks, {sum(b["chars"] for b in blocks) / max(len(blocks), 1):.0f} chars, '
                  f'{ids / max(len(blocks), 1):.1f} ids; in digest {sum(b["in_digest"] for b in blocks)}; cited later {sum(b["cited"] for b in blocks)}/{ids} '
                  f'({sum(b["cited"] for b in blocks) / max(ids, 1):.0%})')
    return {'rows': rows}


def main():
    global A
    A = args_parser().parse_args()
    sys.path.insert(0, A.scripts)
    import claude_sessions
    claude_sessions.transcript_index()  # built once, here: its lazy global is not thread-safe
    A.scratch = A.scratch or tempfile.mkdtemp(prefix='sofar-r4-replay-')
    os.makedirs(A.scratch, exist_ok=True)
    result = {'a2-codex': a2_codex, 'a4-notices': a4_notices, 'a4-store': a4_store, 'a4-recall': a4_recall}[A.what]()
    if A.json:
        with open(A.json, 'w') as f:
            json.dump(result, f, indent=1)


if __name__ == '__main__':
    main()
