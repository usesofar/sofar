// The live A/B behind default-on (context-ceiling 5.2, D17): the ceiling on
// for one stretch of real work, off for another, compared from the Claude
// Code transcripts those stretches left. Reads ~/.claude/projects/<project>/
// only and calls no model.
//
// Run: node scripts/ceiling-ab.mjs --on 2026-10-14..2026-10-17 --off 2026-10-17..2026-10-20
//   [--project <dir>]... [--min 10] [--first 20] [--gap 120] [--json]
// A window is FROM..TO in ISO time, TO exclusive; a transcript belongs to the
// window its first line falls in. Flip the arm with
// `sofar config set context.mode nudge|off` at the window's edge.
//
// Measures, per arm:
// - cost per operator prompt: main-chain plus subagent calls, in the replay's
//   Opus-input-token weights (scripts/ceiling-replay.mjs). Per prompt, not per
//   transcript: a /clear splits one stretch of work into several transcripts,
//   so a per-transcript cost would flatter the on arm by construction (D18).
// - re-reads after a start: of the first `--first` tool calls of a transcript
//   that follows another in the same project within `--gap` minutes, the
//   file reads (Read, Grep, Glob, and cat/sed/head/tail/grep/rg… in Bash)
//   of a path that predecessor had already read. Fresh starts with no
//   predecessor count in neither arm.
// Verdict (D17): ship default-on only when each arm holds at least `--min`
// transcripts with a prompt, cost per prompt falls by 10% or more, and
// re-reads per start rise by no more than 20%.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { callCost, isPrompt, toCall } from './ceiling-replay.mjs'

export const COST_DROP_MIN = 0.1
export const REREAD_RISE_MAX = 0.2

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead'])
const READ_COMMAND = /(^|[\s;&|(])(cat|sed|head|tail|grep|rg|less|nl|wc|awk|jq)\s/
const PATH_TOKEN =
  /(?:^|[\s'"=(])((?:~|\.{1,2})?\/?[\w@.+-]+(?:\/[\w@.+-]+)+|[\w@+-]+\.(?:ts|tsx|js|mjs|cjs|rs|md|json|jsonl|toml|ya?ml|sh|py|txt|css|html))(?=$|[\s'";|)&>:,])/g

// Machine-written user lines (felt-latency D10): a background task's notice,
// a shell or local-command echo, a peer's message. Not the operator's prompt.
const MACHINE_PROMPT = /^\s*<(task-notification|bash-|local-command-|command-|cross-session-message|agent-message|system-reminder)/

function promptText(line) {
  const c = line.message?.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : ''
}

/** An operator prompt: the replay's isPrompt, less what a machine wrote. */
export function isOperatorPrompt(line) {
  return isPrompt(line) && !MACHINE_PROMPT.test(promptText(line))
}

function readLines(file) {
  const lines = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue
    try {
      lines.push(JSON.parse(raw))
    } catch {
      // a torn or foreign line: skipped
    }
  }
  return lines
}

function normalize(path, cwd) {
  let p = path.replace(/^\.\//, '')
  if (cwd && p.startsWith(`${cwd}/`)) p = p.slice(cwd.length + 1)
  return p.replace(/\/+$/, '')
}

/** The paths one tool call reads, or [] when it reads none. */
export function readPaths(name, input, cwd) {
  if (input === null || typeof input !== 'object') return []
  if (READ_TOOLS.has(name)) {
    const p = input.file_path ?? input.notebook_path ?? input.path
    return typeof p === 'string' && p.length > 0 ? [normalize(p, cwd)] : []
  }
  if (name !== 'Bash' || typeof input.command !== 'string' || !READ_COMMAND.test(input.command)) return []
  const out = new Set()
  for (const m of input.command.matchAll(PATH_TOKEN)) {
    const p = m[1]
    if (/^\d|^-|^https?:/.test(p) || p.includes('//')) continue
    out.add(normalize(p, cwd))
  }
  return [...out]
}

/** One transcript's summary: when, prompts, cost, resumed, and its tool calls' reads in order. */
export function summarize(lines, subagentLines = []) {
  let start = null
  let end = null
  let prompts = 0
  let cwd
  let resumed = false
  let sawAssistant = false
  const calls = new Map()
  const tools = new Map()
  for (const line of lines) {
    if (typeof line.timestamp === 'string') {
      start ??= line.timestamp
      end = line.timestamp
    }
    cwd ??= typeof line.cwd === 'string' ? line.cwd : undefined
    if (line.type === 'user' && !sawAssistant && JSON.stringify(line.message?.content ?? '').includes('<command-name>/clear')) resumed = true
    if (isOperatorPrompt(line)) prompts++
    if (line.type !== 'assistant' || line.isSidechain) continue
    sawAssistant = true
    const call = toCall(line)
    const id = line.message?.id ?? line.requestId ?? line.uuid
    if (call) calls.set(id, call)
    for (const b of Array.isArray(line.message?.content) ? line.message.content : []) {
      if (b?.type === 'tool_use' && !tools.has(b.id)) tools.set(b.id, readPaths(b.name, b.input, cwd))
    }
  }
  const side = new Map()
  for (const line of [...lines.filter((l) => l.isSidechain), ...subagentLines]) {
    if (line.type !== 'assistant') continue
    const call = toCall(line)
    if (call) side.set(line.message?.id ?? line.requestId ?? line.uuid, call)
  }
  const sum = (m) => [...m.values()].reduce((n, c) => n + callCost(c), 0)
  return { start, end, prompts, resumed, mainCost: sum(calls), sideCost: sum(side), reads: [...tools.values()] }
}

export function loadProject(dir) {
  const out = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const file = join(dir, f)
    if (!statSync(file).isFile()) continue
    const subDir = join(file.replace(/\.jsonl$/, ''), 'subagents')
    const sub = existsSync(subDir)
      ? readdirSync(subDir)
          .filter((s) => s.endsWith('.jsonl'))
          .flatMap((s) => readLines(join(subDir, s)))
      : []
    const s = summarize(readLines(file), sub)
    if (s.start !== null) out.push({ project: dir, file: f, ...s })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/** Re-reads in each transcript's first `first` tool calls of paths its predecessor (same project, within `gapMs`) read. */
export function attachRereads(transcripts, { first, gapMs }) {
  const byProject = new Map()
  for (const t of transcripts) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t])
  for (const list of byProject.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start))
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      const prev = list
        .slice(0, i)
        .filter((p) => p.end <= t.start && Date.parse(t.start) - Date.parse(p.end) <= gapMs)
        .at(-1)
      if (!prev) {
        t.rereads = null
        continue
      }
      const seen = new Set(prev.reads.flat())
      t.rereads = t.reads.slice(0, first).reduce((n, paths) => n + (paths.some((p) => seen.has(p)) ? 1 : 0), 0)
    }
  }
  return transcripts
}

export function parseWindow(text) {
  const m = /^(.+)\.\.(.+)$/.exec(text ?? '')
  if (!m) throw new Error(`a window is FROM..TO, got ${JSON.stringify(text)}`)
  return { from: m[1], to: m[2] }
}

function armOf(transcripts, { from, to }) {
  const ts = transcripts.filter((t) => t.start >= from && t.start < to && t.prompts > 0)
  const prompts = ts.reduce((n, t) => n + t.prompts, 0)
  const cost = ts.reduce((n, t) => n + t.mainCost + t.sideCost, 0)
  const starts = ts.filter((t) => t.rereads !== null && t.rereads !== undefined)
  const rereads = starts.reduce((n, t) => n + t.rereads, 0)
  return {
    transcripts: ts.length,
    resumed: ts.filter((t) => t.resumed).length,
    prompts,
    cost,
    costPerPrompt: prompts > 0 ? cost / prompts : null,
    starts: starts.length,
    rereadsPerStart: starts.length > 0 ? rereads / starts.length : null,
  }
}

/** The two arms and the D17 verdict. */
export function compare(transcripts, { on, off, min }) {
  const a = armOf(transcripts, on)
  const b = armOf(transcripts, off)
  const reasons = []
  if (a.transcripts < min || b.transcripts < min) reasons.push(`each arm needs ${min} transcripts with a prompt (on ${a.transcripts}, off ${b.transcripts})`)
  const costDrop = a.costPerPrompt !== null && b.costPerPrompt ? 1 - a.costPerPrompt / b.costPerPrompt : null
  let rereadRise = null
  if (a.rereadsPerStart !== null && b.rereadsPerStart !== null) {
    rereadRise = b.rereadsPerStart === 0 ? (a.rereadsPerStart === 0 ? 0 : Infinity) : a.rereadsPerStart / b.rereadsPerStart - 1
  }
  if (costDrop === null) reasons.push('no cost per prompt in one arm')
  else if (costDrop < COST_DROP_MIN) reasons.push(`cost per prompt moved ${signed(-costDrop)}, short of −${pct(COST_DROP_MIN)}`)
  if (rereadRise === null) reasons.push('no start with a predecessor in one arm')
  else if (rereadRise > REREAD_RISE_MAX) reasons.push(`re-reads per start rose ${pct(rereadRise)}, over ${pct(REREAD_RISE_MAX)}`)
  const insufficient = reasons.some((r) => r.startsWith('each arm') || r.startsWith('no '))
  return { on: a, off: b, costDrop, rereadRise, verdict: reasons.length === 0 ? 'ship' : insufficient ? 'insufficient' : 'hold', reasons }
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '∞')
const signed = (x) => (x === null ? '—' : x === Infinity ? '+∞' : `${x >= 0 ? '+' : '−'}${pct(Math.abs(x))}`)

function main(argv) {
  const opts = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []))
  const opt = (name, fallback) => opts(name).at(-1) ?? fallback
  const home = join(homedir(), '.claude/projects')
  const projects = opts('project')
  const dirs = projects.length > 0 ? projects : ['-Users-jins-IO-splen', '-Users-jins-IO-sofar'].map((p) => join(home, p))
  const on = parseWindow(opt('on'))
  const off = parseWindow(opt('off'))
  const min = Number(opt('min', 10))
  const first = Number(opt('first', 20))
  const gapMs = Number(opt('gap', 120)) * 60_000
  const transcripts = attachRereads(
    dirs.filter((d) => existsSync(d)).flatMap(loadProject),
    { first, gapMs },
  )
  const r = compare(transcripts, { on, off, min })
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  const row = (name, a) =>
    `${name}: ${a.transcripts} transcripts (${a.resumed} after /clear), ${a.prompts} prompts, cost/prompt ${a.costPerPrompt === null ? '—' : `${(a.costPerPrompt / 1e3).toFixed(1)}K`}, re-reads/start ${a.rereadsPerStart === null ? '—' : a.rereadsPerStart.toFixed(2)} over ${a.starts} starts`
  console.log(row(`on  ${on.from}..${on.to}`, r.on))
  console.log(row(`off ${off.from}..${off.to}`, r.off))
  console.log(`on vs off: cost per prompt ${signed(r.costDrop === null ? null : -r.costDrop)}; re-reads per start ${signed(r.rereadRise)}`)
  console.log(`verdict: ${r.verdict}${r.reasons.length > 0 ? ` — ${r.reasons.join('; ')}` : ''}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
