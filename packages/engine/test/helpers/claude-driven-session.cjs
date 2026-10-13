#!/usr/bin/env node
/**
 * A stub `claude` binary for driving tests (in-session-drive 2.3): what a
 * DRIVEN Claude Code session looks like from the driver's side, minus the
 * model. It speaks just enough of print mode's stream-json — an `init` line
 * carrying its session id and a `result` line — and writes the record the way
 * a session following the pin would: registered, task done, written back.
 *
 * Plain CommonJS with no imports from the engine, for the reason
 * codex-driven-session.cjs gives: anything borrowed would be the engine
 * grading its own homework.
 *
 * Environment:
 *   STUB_OUT     directory; the session's environment is dumped to env-<session id>
 *                and its pid to pid-<session id>
 *   STUB_LINGER  "1": after writing back, stay alive until signalled — the
 *                shape a stop request has to interrupt
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
// As Claude Code does: the id the driver assigned (--session-id, drive-lanes
// 7.5), and the initiative from the pin line, else from the run's frame.
const frame = args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] || '' : ''
const initiative = (/initiative "([^"]+)"/.exec(prompt) || /initiative `([^`]+)`/.exec(frame) || /initiative `([^`]+)`/.exec(prompt))[1]
const taskId = /Task (\S+) —/.exec(prompt)[1]
const sessionId = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : crypto.randomUUID()
const log = path.join(process.cwd(), '.sofar', 'initiatives', initiative, 'events.jsonl')

if (process.env.STUB_OUT) {
  fs.writeFileSync(path.join(process.env.STUB_OUT, `env-${sessionId}`), Object.keys(process.env).sort().map((k) => `${k}=${process.env[k]}`).join('\n'))
  fs.writeFileSync(path.join(process.env.STUB_OUT, `pid-${sessionId}`), String(process.pid))
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let seq = 0
function ulid() {
  let t = Date.now()
  let head = ''
  for (let i = 0; i < 10; i += 1) {
    head = B32[t % 32] + head
    t = Math.floor(t / 32)
  }
  seq += 1
  return head + String(seq).padStart(16, '0')
}

function append(type, payload) {
  fs.appendFileSync(
    log,
    JSON.stringify({
      v: 1,
      id: ulid(),
      ts: new Date().toISOString(),
      initiative,
      session: sessionId,
      source: 'claude-code',
      actor: 'agent',
      type,
      payload,
    }) + '\n',
  )
}

process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'stub' }) + '\n')
append('session_started', { tool: 'claude-code' })
append('task_status_changed', { id: taskId, status: 'done' })
append('session_ended', { summary: 'did ' + taskId, next_action: 'the next one' })

function finish(code) {
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0.01 }) + '\n',
    () => process.exit(code),
  )
}

if (process.env.STUB_LINGER === '1') {
  process.on('SIGTERM', () => finish(143))
  setInterval(() => {}, 1000)
} else {
  finish(0)
}
