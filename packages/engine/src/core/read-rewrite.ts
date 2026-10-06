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
