import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nameable, promptNames } from './carrier'
import { addTold, readTold } from './told'

/**
 * Paged protocol clauses (felt-latency L3, r4-fixes B9's first lever). The
 * CLAUDE.md block rides every model call, and these three clauses were 41% of
 * it (2.2 of 5.3 KB) while most sessions never plan, link or drive. The block
 * keeps PAGED_POINTER in their place; the prompt hook pages a clause in, once
 * per context, with the first prompt that calls for it.
 *
 * Each clause is V14's text byte for byte (init.ts derives the paged block by
 * cutting exactly these strings), so a paged-in clause reads as the block did.
 */
export const PAGED_CLAUSES = {
  plan: `- PLAN: when the operator hands you a roadmap, a spec or a list of steps,
  put their words in the plan's \`brief\` VERBATIM (\`sofar_update_plan\`)
  before you decompose them into phases and tasks. Tasks are your summary
  and lose words; the brief is what "the next item on the roadmap" means in
  a later session, and a finished task list does not finish the brief. A
  replace that omits \`brief\` keeps the last one. Never retype or resend
  it to add to it: sofar keeps a session's prompts as P1, P2, … (the prompt
  hook names a long one), so keep the operator's by id —
  \`sofar_end_session\` \`brief_append: ["P1"]\` — and sofar copies it
  verbatim; words with no id go in \`brief_append\` as they are.
`,
  links: `- LINKS: name another record's task, decision or memory as \`<slug> <id>\`
  (\`billing 2.3\`, \`billing D4\`, \`billing M2\`) — a bare id means this
  record's. When a task cannot finish until something in another record
  moves, mark it blocked AND declare it: \`waits_on: ["<slug> <id>"]\` (or
  the whole \`<slug>\`) on the task change. A cite is only offered as worth
  reading; a declared wait is what the Travel block reports as moved or
  resolved.
`,
  driving: `- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  \`sofar drive --keep-awake-setting on|off\`. Do not start a watcher:
  sofar's rewake hook watches the run you detached and, when it stops or
  its driver dies, wakes this session with ONE line — relay it (a
  needs_user stop carries the operator's question). Only when
  \`.claude/hooks/drive-await.sh\` is absent, run
  \`sofar drive <slug> --await\` in a background shell instead; it prints
  that same line and exits. Do not write to that record again while the
  run goes. \`sofar drive <slug> --stop\` ends it.
`,
} as const

export type PagedClause = keyof typeof PAGED_CLAUSES

/** What the block says in the clauses' place. */
export const PAGED_POINTER = `- PLAN, LINKS, DRIVING: each clause reaches you with the first prompt that
  needs it (a roadmap or spec, another record named, a drive asked for).
`

/** A prompt word that asks for the clause. Words split as promptIntends splits them. */
const CUE_WORDS: Readonly<Record<PagedClause, readonly string[]>> = {
  plan: ['roadmap', 'roadmaps', 'spec', 'specs', 'specification', 'prd', 'milestone', 'milestones', 'phases', 'requirements'],
  links: ['blocked', 'depends', 'dependency', 'dependencies', 'prerequisite', 'waits_on'],
  driving: ['drive', 'driving', 'unattended', 'overnight'],
}

/** A list of steps: at least this many lines that open with `-`, `*` or `1.`. */
const LIST_LINES_MIN = 3

/**
 * The clauses this prompt calls for, in block order. PLAN also answers a
 * pasted list of steps, and LINKS any other record named (nameable slugs only,
 * as the carriers read them).
 */
export function promptClauses(prompt: string, otherSlugs: readonly string[]): PagedClause[] {
  const lower = prompt.toLowerCase()
  const words = new Set(lower.split(/[^a-z0-9'_-]+/).filter((w) => w.length > 0))
  const cued = (c: PagedClause): boolean => CUE_WORDS[c].some((w) => words.has(w))
  const listed = lower.split('\n').filter((l) => /^\s*(?:[-*]|\d+[.)])\s/.test(l)).length >= LIST_LINES_MIN
  const due: PagedClause[] = []
  if (cued('plan') || listed) due.push('plan')
  if (cued('links') || otherSlugs.some((s) => nameable(s) && promptNames(prompt, s))) due.push('links')
  if (cued('driving')) due.push('driving')
  return due
}

/** The told key a paged clause is spent under; SessionStart clears it on compact and clear. */
export function pagedToldKey(clause: PagedClause): string {
  return `%paged:${clause}`
}

/** True when the repo's CLAUDE.md carries the paged block, so the clauses are not already in context. */
export function clausesPagedOut(rootDir: string): boolean {
  try {
    return readFileSync(join(rootDir, 'CLAUDE.md'), 'utf8').includes(PAGED_POINTER)
  } catch {
    return false
  }
}

/**
 * The prompt line that pages clauses in, or null. Spent once per clause per
 * context; never when CLAUDE.md still holds the whole block (an older block,
 * or the inline write-back mode's), which already says all three.
 */
export function pagedClauseLine(rootDir: string, sofarDir: string, sessionId: string, prompt: string, otherSlugs: readonly string[]): string | null {
  const due = promptClauses(prompt, otherSlugs)
  if (due.length === 0) return null
  const told = readTold(sofarDir, sessionId)
  const fresh = due.filter((c) => !told.has(pagedToldKey(c)))
  if (fresh.length === 0 || !clausesPagedOut(rootDir)) return null
  addTold(sofarDir, sessionId, fresh.map(pagedToldKey))
  return `sofar protocol, paged in for this prompt:\n${fresh.map((c) => PAGED_CLAUSES[c]).join('').trimEnd()}`
}

/**
 * Whether the prompt hook may offer a long prompt's `P<n>` id. The offer ("if
 * it is roadmap or spec, keep it…") leans on PLAN's judgement: in the A/B, with
 * PLAN paged out and the offer on every long prompt, 3 of 3 sessions filed a
 * plain coding request as brief, against 0 of 3 under V14. So with the clauses
 * paged out the offer rides only with PLAN in this context; capture is unchanged.
 */
export function keepOfferAllowed(rootDir: string, sofarDir: string, sessionId: string): boolean {
  return !clausesPagedOut(rootDir) || readTold(sofarDir, sessionId).has(pagedToldKey('plan'))
}
