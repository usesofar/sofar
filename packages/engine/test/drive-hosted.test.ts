import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cloudDriveArgs, driveHosted, exportedEvents, hostedPrompt, HOSTED_DONE } from '../src/driver/hosted'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-hosted-test-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const row = (type: string, content: unknown): string =>
  JSON.stringify({ type, ...(type === 'system' ? { subtype: 'stop_hook_summary' } : { message: { content } }) })

describe('a hosted run (drive-lanes 5.5)', () => {
  it('hands the cloud drive the operator flags, minus what only means something here', () => {
    expect(
      cloudDriveArgs(['lanes', '--hosted', 'cloud', '--max-sessions', '3', '--root', '/here', '--bin=/b/claude', '--agent-arg', '--debug', '--allow', 'Bash(node:*)', '--detach']),
    ).toEqual(['lanes', '--max-sessions', '3', '--allow', 'Bash(node:*)'])
  })

  it('asks the host to write back, detach, await, then print the patch and the record', () => {
    const p = hostedPrompt('lanes', ['lanes', '--max-sessions', '3', '--allow', 'Bash(node:*)'], 'abc', '01EVT')
    expect(p).toContain(`env -u CLAUDE_CODE_REMOTE_SESSION_ID sofar drive lanes --max-sessions 3 --allow 'Bash(node:*)' --detach`)
    expect(p).toContain('sofar drive lanes --await')
    expect(p).toContain("git format-patch abc..HEAD --stdout -- . ':(exclude).sofar'")
    expect(p).toContain(`sofar export lanes --since 01EVT | grep -v -e '"type":"command_run"' -e '"type":"file_touched"'`)
    expect(p).toContain(HOSTED_DONE)
  })

  it('reads the exported events as the last output made only of event lines', () => {
    const ev = '{"v":1,"id":"01A","type":"handoff","payload":{}}'
    expect(exportedEvents({ started: true, ended: true, finalText: null, patch: null, outputs: [`${ev}\n${ev}\n`, 'await exit 0'] })).toBe(`${ev}\n${ev}\n`)
    expect(exportedEvents({ started: true, ended: true, finalText: null, patch: null, outputs: ['nothing here'] })).toBeNull()
  })

  it('launches one cloud session, waits for its done mark, applies the run commits and imports its events', async () => {
    const root = tmp()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.name', 'local')
    git(repo, 'config', 'user.email', 'local@example.com')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'init')
    const cloud = join(root, 'cloud')
    git(root, 'clone', '-q', repo, cloud)
    for (const [f, msg] of [['b.txt', '1.1: b'], ['c.txt', '1.2: c']]) {
      writeFileSync(join(cloud, f!), `${f}\n`)
      git(cloud, 'add', f!)
      git(cloud, 'commit', '-qm', msg!)
    }
    const patch = git(cloud, 'format-patch', 'HEAD~2..HEAD', '--stdout')
    const ev = '{"v":1,"id":"01B","initiative":"lanes","type":"handoff","payload":{"reason":"task_done"}}'
    const config = join(root, 'config')
    // First poll: still running; second: the host's turn ended on the done mark.
    writeFileSync(join(root, 'poll-1.jsonl'), [row('user', 'go'), row('assistant', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])].join('\n'))
    writeFileSync(
      join(root, 'poll-2.jsonl'),
      [
        row('user', 'go'),
        row('user', [{ type: 'tool_result', tool_use_id: 't', content: 'await exit 0' }]),
        row('user', [{ type: 'tool_result', tool_use_id: 'p', content: patch }]),
        row('user', [{ type: 'tool_result', tool_use_id: 'e', content: `${ev}\n` }]),
        row('assistant', [{ type: 'text', text: `Run done.\n${HOSTED_DONE}` }]),
        row('system', null),
      ].join('\n'),
    )
    const claude = join(root, 'claude')
    writeFileSync(
      claude,
      [
        '#!/bin/sh',
        `case "$*" in *--cloud*) printf "%s" "$*" > ${join(root, 'prompt')}; echo "View: https://claude.ai/code/session_01HOSTabcdefgh"; exit 0 ;; esac`,
        `n=$(($(cat ${join(root, 'polls')} 2>/dev/null || echo 0) + 1)); echo $n > ${join(root, 'polls')}`,
        `mkdir -p ${config}/projects/p && cp ${root}/poll-$n.jsonl ${config}/projects/p/local-$n.jsonl`,
        'echo "{\\"session_id\\":\\"local-$n\\"}"; exit 1',
      ].join('\n'),
    )
    const script = join(root, 'script')
    writeFileSync(script, '#!/bin/sh\nlog="$2"; shift 2; "$@" > "$log" 2>&1\n')
    const sofar = join(root, 'sofar')
    writeFileSync(
      sofar,
      `#!/bin/sh\ncase "$1" in export) echo '{"v":1,"id":"01A","type":"initiative_created","payload":{}}' ;; import) cp "$2" ${join(root, 'imported')}; echo "$3" > ${join(root, 'imported-slug')} ;; esac\n`,
    )
    for (const b of [claude, script, sofar]) chmodSync(b, 0o755)

    const progress: string[] = []
    const outcome = await driveHosted(repo, 'lanes', {
      driveArgs: ['lanes', '--max-sessions', '2'],
      bin: claude,
      scriptBin: script,
      sofarBin: sofar,
      configDir: config,
      pollMs: 10,
      platform: 'darwin',
      onProgress: (l) => progress.push(l),
    })

    expect(outcome).toMatchObject({ ok: true, cloudId: 'session_01HOSTabcdefgh', commits: 2, events: 1 })
    // The prompt starts the run from HEAD and exports only what came after the local record.
    const prompt = readFileSync(join(root, 'prompt'), 'utf8')
    expect(prompt).toContain('env -u CLAUDE_CODE_REMOTE_SESSION_ID sofar drive lanes --max-sessions 2 --detach')
    expect(prompt).toContain(`git format-patch ${git(repo, 'rev-parse', 'HEAD~2').trim()}..HEAD`)
    expect(prompt).toContain('sofar export lanes --since 01A')
    expect(git(repo, 'log', '--format=%s', '-2').trim().split('\n')).toEqual(['1.2: c', '1.1: b'])
    expect(readFileSync(join(root, 'imported'), 'utf8')).toBe(`${ev}\n`)
    expect(readFileSync(join(root, 'imported-slug'), 'utf8').trim()).toBe('lanes')
    expect(progress[0]).toBe('hosted: cloud session session_01HOSTabcdefgh runs lanes — https://claude.ai/code/session_01HOSTabcdefgh')
  })

  it('refuses uncommitted work: the cloud session starts from HEAD', async () => {
    const repo = tmp()
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'init')
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    const outcome = await driveHosted(repo, 'lanes', { driveArgs: ['lanes'], bin: '/nonexistent', sofarBin: '/nonexistent' })
    expect(outcome.ok).toBe(false)
    expect(outcome.lines[0]).toContain('commit your work first')
  })
})
