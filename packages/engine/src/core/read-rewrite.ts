import { basename, dirname, resolve } from 'node:path'

/**
 * The read rewrite (memory-lead 4.3 part C; D39, D42): an agent's own
 * whole-file read of a record projection becomes `sofar read`, which hands back
 * the index view and, on a re-read in the same session context, only what
 * changed. In round 3 these reads were sofar's largest cost: 1.29–1.34M chars
 * a chain, the opening `cat plan.md decisions.md memory.md` most of it.
 *
 * Narrow by construction, because a rewrite the agent did not expect is worse
 * than a read it paid for: ONE shell segment whose program is `cat`, `less`
 * or `more`, whose every operand is a record's `plan.md`, `decisions.md`,
 * `memory.md` or `events.jsonl`, with no pipe, redirection, substitution or
 * sequencing. A grep or a `sed -n` asks for something specific and is left
 * alone.
 *
 * Whole-file reads only (r4-fixes U4): a read with a line or byte limit —
 * `head`, `tail`, `head -c`, `sed -n` — passes through untouched, as does any
 * read inside a compound command. The view is the whole file, so rewriting a
 * limited read handed back more than was asked for: round 4's `tail -25
 * plan.md` returned 5,094 chars where the original returned 2,076.
 */

/** Env switch: `SOFAR_READ_GATE=off` (also `0`, `false`) — the ablation arm (D39). */
export const READ_GATE_ENV = 'SOFAR_READ_GATE'

export function readGateEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[READ_GATE_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** Programs that print a whole file. `head` and `tail` never do: they stop at a count, 10 lines by default. */
const READERS = new Set(['cat', 'less', 'more'])
export const PROJECTIONS = new Set(['plan.md', 'decisions.md', 'memory.md', 'brief.md', 'events.jsonl'])

/** Is `abs` a record projection: `<root>/.sofar/initiatives/<slug>/<projection>`? */
export function isProjection(abs: string, rootDir: string): boolean {
  if (!PROJECTIONS.has(basename(abs))) return false
  const initiatives = dirname(dirname(abs))
  return basename(initiatives) === 'initiatives' && dirname(initiatives) === resolve(rootDir, '.sofar')
}

const quote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`

/**
 * The command a whole-file read of record projections becomes, or null when
 * `cmd` is anything else. `cwd` is where the agent's shell runs; operands
 * resolve against it and are passed on as the agent typed them.
 */
export function rewriteRawRead(cmd: string, cwd: string, rootDir: string, session: string): string | null {
  if (/[|&;<>`$()\n\\"]/.test(cmd)) return null
  const tokens = cmd.trim().split(/\s+/).filter((t) => t.length > 0)
  const head = tokens[0]
  if (head === undefined || !READERS.has(head)) return null
  const files: string[] = []
  for (const token of tokens.slice(1)) {
    let t = token
    if (t.length > 1 && t.startsWith("'") && t.endsWith("'")) t = t.slice(1, -1)
    if (t.includes("'")) return null
    if (t.startsWith('-')) {
      if (t === '-n' && head === 'cat') continue // line numbers: the view has none to number
      return null
    }
    if (!isProjection(resolve(cwd, t), rootDir)) return null
    files.push(t)
  }
  if (files.length === 0) return null
  return `sofar read --session ${quote(session)} ${files.map(quote).join(' ')}`
}

/**
 * Per segment (r4-fixes A4; R4-RESEARCH 1.1 #4, extending U4): round 4's raw
 * reads were 145 of 172 compound — `ls; cat lib/x.ts; cat .sofar/…/memory.md
 * | head -80` — which the whole-command rewrite skips by construction. Here
 * every simple command that heads a pipeline and is itself a whole-file read
 * (the same rule as above: `cat`/`less`/`more`, only projections, `cat -n`
 * allowed, plus a trailing `2>/dev/null`) becomes `sofar read`, and every
 * other byte of the command is kept: a `| head -80` after it still limits
 * what `sofar read` prints, and a limited read (`head`, `tail`, `sed -n`)
 * still passes through. A command holding a backtick, `$(`, a heredoc or a
 * backslash is not split at all. Null when no segment is rewritten.
 *
 * Under `SOFAR_TOLD_LINES=off` only the whole-command form above runs.
 */
export function rewriteRawReadSegments(cmd: string, cwd: string, rootDir: string, session: string): string | null {
  const whole = rewriteRawRead(cmd, cwd, rootDir, session)
  if (whole !== null) return whole
  if (/[`\\]|\$\(|<</.test(cmd)) return null
  // Spans of simple commands, and whether each heads its pipeline.
  const spans: Array<{ start: number; end: number; heads: boolean }> = []
  let quote: '"' | "'" | null = null
  let start = 0
  let heads = true
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote !== null) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    const two = cmd.slice(i, i + 2)
    let width = 0
    let pipe = false
    if (two === '&&' || two === '||') width = 2
    else if (c === '|') {
      width = 1
      pipe = true
    } else if (c === ';' || c === '\n' || c === '&') width = 1
    if (width === 0) continue
    spans.push({ start, end: i, heads })
    heads = !pipe
    start = i + width
    i += width - 1
  }
  if (quote !== null) return null
  spans.push({ start, end: cmd.length, heads })
  let out = ''
  let at = 0
  let changed = false
  for (const span of spans) {
    if (!span.heads) continue
    const text = cmd.slice(span.start, span.end)
    const lead = /^\s*/.exec(text)![0]
    const trail = /\s*$/.exec(text)![0]
    let body = text.slice(lead.length, text.length - trail.length)
    let redirect = ''
    if (body.endsWith(' 2>/dev/null')) {
      redirect = ' 2>/dev/null'
      body = body.slice(0, -redirect.length).trimEnd()
    }
    if (/[<>]/.test(body)) continue
    const rewritten = rewriteRawRead(body, cwd, rootDir, session)
    if (rewritten === null) continue
    out += cmd.slice(at, span.start) + lead + rewritten + redirect + trail
    at = span.end
    changed = true
  }
  return changed ? out + cmd.slice(at) : null
}
