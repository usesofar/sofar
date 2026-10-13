// One Claude Code cloud session as a host for a bench arm (drive-lanes 6.3):
// launch it on the cell repo, poll its transcript for $0 until its turn ends,
// and read back what it packed. The same transport the engine's
// `sofar drive --hosted cloud` uses (D51, D55), kept here in plain JS because
// the native-cloud arm runs no sofar at all.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const DONE = 'SOFAR-BENCH-HOST-DONE'
export const SEP = 'SOFAR-BENCH-SEP'
export const CHUNK = 24_000
const NO_MODEL = 'claude-none-0'
const MARKER = 'This session is being continued from another machine'

/**
 * The host's prompt for a native-cloud rep: run Claude Code on the plan in
 * the background (its own subagents, the same flags as the local native
 * arm), wait it out, then pack its commits and its JSON result in chunks.
 */
export function nativeHostPrompt(nativePrompt, flags, base) {
  const child = ['env -u CLAUDE_CODE_REMOTE_SESSION_ID claude -p "$(cat /tmp/native.prompt.txt)"', '--output-format json', ...flags].join(' ')
  return [
    'You host one benchmark run in this cloud session. Do no task work yourself and call no other tool; run exactly these commands from the repository root, in order:',
    '',
    `1. cat > /tmp/native.prompt.txt <<'SOFAR_NATIVE_EOF'\n${nativePrompt}\nSOFAR_NATIVE_EOF`,
    `2. nohup ${child} < /dev/null > /tmp/native.json 2> /tmp/native.err & echo $! > /tmp/native.pid; echo started`,
    '3. Wait for it: timeout 540 sh -c \'while kill -0 $(cat /tmp/native.pid) 2>/dev/null; do sleep 5; done\'; echo "wait exit $?" — repeat this exact command until it prints an exit other than 124.',
    `4. { git format-patch ${base}..HEAD --stdout; echo ${SEP}; tail -c 20000 /tmp/native.json; } | gzip -9 | base64 -w0 > /tmp/bench.b64; echo "SOFAR-CHUNKS $(( ($(wc -c < /tmp/bench.b64) + ${CHUNK - 1}) / ${CHUNK} ))"`,
    `5. For each i from 1 to that count, run this as its OWN command (one per chunk, nothing piped after it): i=<i>; echo "SOFAR-CHUNK $i"; cut -c $(( (i-1)*${CHUNK} + 1 ))-$(( i*${CHUNK} )) /tmp/bench.b64`,
    '',
    `Then end your reply with the line ${DONE}.`,
  ].join('\n')
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}

/** Launch a cloud session from `repo` under script(1); its id, or a throw. */
export function launch(repo, claude, prompt) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-host-'))
  try {
    const log = join(dir, 'launch.log')
    run('script', ['-q', log, claude, '--cloud', prompt], repo)
    const id = /session_[A-Za-z0-9]{8,}/.exec(existsSync(log) ? readFileSync(log, 'utf8') : '')?.[0]
    if (id === undefined) throw new Error('the cloud launch named no session')
    return id
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
  return null
}

/** One $0 poll from a clean checkout: the cloud part of the transcript, or null. */
export function poll(cleanDir, claude, id, configDir = join(homedir(), '.claude')) {
  const out = run(claude, ['--teleport', id, '-p', '.', '--model', NO_MODEL, '--output-format', 'json'], cleanDir)
  let local
  try {
    local = JSON.parse(out.stdout).session_id
  } catch {
    return null
  }
  const projects = join(configDir, 'projects')
  let path
  for (const d of readdirSync(projects)) if (existsSync(join(projects, d, `${local}.jsonl`))) path = join(projects, d, `${local}.jsonl`)
  if (path === undefined) return null
  const rows = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.type === 'user' && typeof r.message?.content === 'string' && r.message.content.startsWith(MARKER)) break
    if (['user', 'assistant', 'system'].includes(r.type)) rows.push(r)
  }
  rmSync(path, { force: true })
  rmSync(path.replace(/\.jsonl$/, ''), { recursive: true, force: true })
  const outputs = []
  let finalText = ''
  for (const r of rows) {
    const c = r.message?.content
    if (r.type === 'assistant') {
      const t = textOf(c)
      if (t) finalText = t
    }
    if (r.type === 'user' && Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result') outputs.push(textOf(b.content) ?? '')
  }
  const ended = rows.length > 0 && rows[rows.length - 1].type === 'system'
  return { ended, done: ended && finalText.includes(DONE), finalText, outputs }
}

/** The patch and the payload the host's chunks carry. */
export function unpack(outputs) {
  let count
  const chunks = new Map()
  for (const out of outputs) {
    const total = /^SOFAR-CHUNKS (\d+)\s*$/m.exec(out)
    if (total) count = Number(total[1])
    const chunk = /^SOFAR-CHUNK (\d+)\n([A-Za-z0-9+/=\s]*)$/.exec(out)
    if (chunk) chunks.set(Number(chunk[1]), chunk[2].replace(/\s+/g, ''))
  }
  if (count === undefined) throw new Error('the host packed nothing')
  for (let i = 1; i <= count; i++) if (!chunks.has(i)) throw new Error(`chunk ${i} of ${count} never printed`)
  const text = gunzipSync(Buffer.from(Array.from({ length: count }, (_, i) => chunks.get(i + 1)).join(''), 'base64')).toString('utf8')
  const at = text.indexOf(`\n${SEP}\n`)
  if (at >= 0) return { patch: text.slice(0, at + 1), payload: text.slice(at + SEP.length + 2) }
  if (text.startsWith(`${SEP}\n`)) return { patch: '', payload: text.slice(SEP.length + 1) }
  return { patch: text, payload: '' }
}

/** Launch, wait for the done mark (polling every `pollMs`), and unpack. */
export async function hostRun(repo, claude, prompt, { pollMs = 20_000, timeoutMs = 3 * 3_600_000, log = () => {} } = {}) {
  const base = run('git', ['rev-parse', 'HEAD'], repo).stdout.trim()
  const id = launch(repo, claude, prompt)
  log(`cloud host ${id} — https://claude.ai/code/${id}`)
  const wt = join(mkdtempSync(join(tmpdir(), 'bench-poll-')), 'wt')
  run('git', ['worktree', 'add', '--detach', wt, base], repo)
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const seen = poll(wt, claude, id)
      if (seen?.done) return { id, ...unpack(seen.outputs), finalText: seen.finalText }
      if (Date.now() > deadline) throw new Error(`gave up on ${id}`)
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } finally {
    run('git', ['worktree', 'remove', '--force', wt], repo)
  }
}
