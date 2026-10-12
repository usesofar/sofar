import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeCloudAdapter, cloudPrompt, cloudSessionId, readCloudTranscript, scriptArgv } from '../src/driver/claude-cloud'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-cloud-test-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const row = (type: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, ...(type === 'system' ? { subtype: 'stop_hook_summary' } : { message: { content } }), ...extra })

const BLOCK = '```sofar\n{"summary":"did it","next_action":"next","tasks":[{"task_id":"1.1","status":"done"}]}\n```'

describe('the cloud transcript (D51)', () => {
  it('reads a finished session: its last reply and the patch its last command printed', () => {
    const patch = `From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] x\n`
    // Seen live: tests, commit and format-patch in one command, so the patch follows other output.
    const printed = `# pass 5\n# fail 0\n${patch}`
    const t = readCloudTranscript(
      [
        row('user', 'do the task'),
        row('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
        row('user', [{ type: 'tool_result', tool_use_id: 't1', content: printed }]),
        row('assistant', [{ type: 'text', text: `done\n${BLOCK}` }]),
        row('system', null),
        // The teleport's own turn is not the cloud session's.
        row('user', 'This session is being continued from another machine. Application state may have changed.'),
        row('user', '.'),
        row('assistant', [{ type: 'text', text: "There's an issue with the selected model" }]),
      ].join('\n'),
    )
    expect(t).toEqual({ started: true, ended: true, finalText: `done\n${BLOCK}`, patch })
  })

  it('takes the reply holding the block when a cloud Stop hook made the session answer again (seen live)', () => {
    const t = readCloudTranscript(
      [
        row('user', 'go'),
        row('assistant', [{ type: 'text', text: `done\n${BLOCK}` }]),
        row('user', 'Stop hook feedback: Write back to the sofar record before finishing'),
        row('assistant', [{ type: 'text', text: 'No response requested.' }]),
        row('system', null),
      ].join('\n'),
    )
    expect(t.ended).toBe(true)
    expect(t.finalText).toBe(`done\n${BLOCK}`)
  })

  it('a session mid-tool, or not started, has not ended', () => {
    expect(readCloudTranscript([row('user', 'go'), row('assistant', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])].join('\n')).ended).toBe(false)
    expect(readCloudTranscript(row('user', 'This session is being continued from another machine.'))).toEqual({ started: false, ended: false, finalText: null, patch: null })
  })

  it('names the cloud session from the launch log, and spells script(1) per platform', () => {
    expect(cloudSessionId('Created cloud session: x\nView: https://claude.ai/code/session_011mgmshCwSNR3TcAfk3oBoy?from=cli')).toBe('session_011mgmshCwSNR3TcAfk3oBoy')
    expect(cloudSessionId('nothing here')).toBeUndefined()
    expect(scriptArgv('darwin', '/l', ['claude', '--cloud', 'a b'])).toEqual(['-q', '/l', 'claude', '--cloud', 'a b'])
    expect(scriptArgv('linux', '/l', ['claude', '--cloud', 'a b'])).toEqual(['-q', '-e', '-c', "claude --cloud 'a b'", '/l'])
  })

  it('asks for the patch from the commit it starts on, without the record', () => {
    const prompt = cloudPrompt({ cwd: '/w', initiative: 'demo', prompt: 'Task 1.1', frame: 'FRAME' }, 'abc123')
    expect(prompt.startsWith('FRAME\n\nTask 1.1')).toBe(true)
    expect(prompt).toContain("git format-patch abc123..HEAD --stdout -- . ':(exclude).sofar'")
  })
})

describe('ClaudeCloudAdapter', () => {
  it('launches under script, polls until the session ends, applies its patch and files its block', async () => {
    const root = tmp()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.name', 'lane')
    git(repo, 'config', 'user.email', 'lane@example.com')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'init')
    // The cloud session's work, made in a clone of the same commit.
    const cloud = join(root, 'cloud')
    git(root, 'clone', '-q', repo, cloud)
    writeFileSync(join(cloud, 'b.txt'), 'b\n')
    git(cloud, 'add', 'b.txt')
    git(cloud, 'commit', '-qm', '1.1: b')
    const patch = git(cloud, 'format-patch', 'HEAD~1..HEAD', '--stdout')

    // Two polls: the first finds the session still running, the second finished.
    const config = join(root, 'config')
    mkdirSync(join(config, 'projects', 'p'), { recursive: true })
    const running = [row('user', 'go'), row('assistant', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])].join('\n')
    const done = [
      row('user', 'go'),
      row('assistant', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
      row('user', [{ type: 'tool_result', tool_use_id: 't', content: patch }]),
      row('assistant', [{ type: 'text', text: BLOCK }]),
      row('system', null),
    ].join('\n')
    writeFileSync(join(root, 'poll-1.jsonl'), running)
    writeFileSync(join(root, 'poll-2.jsonl'), done)
    const claude = join(root, 'claude')
    writeFileSync(
      claude,
      [
        '#!/bin/sh',
        'case "$*" in',
        '  *--cloud*) echo "View: https://claude.ai/code/session_01TESTabcdefgh?from=cli"; printf "%s" "$*" > ' + join(root, 'launch-args') + '; exit 0 ;;',
        'esac',
        `n=$(($(cat ${join(root, 'polls')} 2>/dev/null || echo 0) + 1)); echo $n > ${join(root, 'polls')}`,
        `cp ${root}/poll-$n.jsonl ${config}/projects/p/local-$n.jsonl`,
        'echo "{\\"session_id\\":\\"local-$n\\",\\"total_cost_usd\\":0}"',
        'exit 1',
      ].join('\n'),
    )
    const script = join(root, 'script')
    writeFileSync(script, '#!/bin/sh\nlog="$2"; shift 2; "$@" > "$log" 2>&1\n')
    const sofar = join(root, 'sofar')
    writeFileSync(sofar, `#!/bin/sh\necho "$*" >> ${join(root, 'sofar-calls')}\nif [ "$2" = stop ]; then cat > ${join(root, 'stop-input')}; fi\n`)
    for (const bin of [claude, script, sofar]) chmodSync(bin, 0o755)

    const adapter = new ClaudeCloudAdapter({ bin: claude, scriptBin: script, sofarBin: sofar, configDir: config, pollMs: 10, platform: 'darwin' })
    const session = adapter.launch({ cwd: repo, initiative: 'demo', prompt: 'Task 1.1', frame: 'FRAME' })
    const exit = await session.wait()

    expect(exit).toEqual({ code: 0, session_id: session.sessionId })
    expect(session.cloudId).toBe('session_01TESTabcdefgh')
    expect(readFileSync(join(root, 'polls'), 'utf8').trim()).toBe('2')
    expect(readFileSync(join(root, 'launch-args'), 'utf8')).toContain('--cloud FRAME')
    // The work landed as an ordinary commit in the worktree.
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('1.1: b')
    const calls = readFileSync(join(root, 'sofar-calls'), 'utf8').trim().split('\n')
    expect(calls[0]).toBe(`event append demo --session ${session.sessionId} --source claude-cloud --type session_started --payload {"tool":"claude-cloud"}`)
    expect(calls[1]).toBe('event stop')
    expect(JSON.parse(readFileSync(join(root, 'stop-input'), 'utf8'))).toEqual({
      session_id: session.sessionId,
      cwd: repo,
      hook_event_name: 'Stop',
      stop_hook_active: true,
      last_assistant_message: BLOCK,
    })
    expect(existsSync(join(repo, '.git', 'rebase-apply'))).toBe(false)
  })

  it('stops polling when killed, and reports the signal', async () => {
    const root = tmp()
    git(root, 'init', '-q', '-b', 'main')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-qm', 'init')
    const bin = join(root, 'claude')
    writeFileSync(bin, '#!/bin/sh\ncase "$*" in *--cloud*) echo session_01TESTabcdefgh ;; *) echo "{}" ;; esac\n')
    const script = join(root, 'script')
    writeFileSync(script, '#!/bin/sh\nlog="$2"; shift 2; "$@" > "$log" 2>&1\n')
    const sofar = join(root, 'sofar')
    writeFileSync(sofar, '#!/bin/sh\nexit 0\n')
    for (const b of [bin, script, sofar]) chmodSync(b, 0o755)
    const session = new ClaudeCloudAdapter({ bin, scriptBin: script, sofarBin: sofar, configDir: join(root, 'none'), pollMs: 60_000, platform: 'darwin' }).launch({
      cwd: root,
      initiative: 'demo',
      prompt: 'Task 1.1',
    })
    await new Promise((r) => setTimeout(r, 300))
    session.kill()
    expect(await session.wait()).toEqual({ code: null, signal: 'SIGTERM', session_id: session.sessionId })
  })
})
