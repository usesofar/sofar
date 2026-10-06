/**
 * Cursor without a Stop gate (r4-fixes A9; R18 verdict in
 * test/fixtures/cursor/README.md).
 *
 * Headless `cursor-agent -p`, the mode the bench and `sofar drive --agent
 * cursor` run, fires no `stop` hook: round 4's 9 Cursor sessions never reached
 * the gate that holds Claude and Codex until a covering test passes. Rep 1's
 * S18 shipped an approval path that broke G1 (D7), and only a Claude session
 * three sessions later repaired it. What print mode does fire is postToolUse
 * and sessionEnd, so the gate's two jobs move there:
 *
 * - At the EDIT (postToolUse): the rules that govern the edited path, by
 *   handle and in their own words. The read-time notice already names guarded
 *   rules, but at most two or three, oldest first, and once per path: S18's
 *   read of lib/inventory/index.ts named D1 and D2 and folded D7 into "…and 7
 *   more", and the edit after it said nothing. This line names every governing
 *   rule once per path a session edits, and a rule's text once per session.
 * - At the END (sessionEnd): what the gate would have asked, written as a note
 *   for the next session to act on ("unverified edits on rule-bound paths"),
 *   since no follow-up turn can reach this one.
 *
 * `SOFAR_CURSOR_DEBT=off` is the ablation arm for both. Wording stays factual,
 * as for every hook line (record-index D2).
 */

/** Env switch: `SOFAR_CURSOR_DEBT=off` (also `0`, `false`) turns both Cursor lines off. */
export const CURSOR_DEBT_ENV = 'SOFAR_CURSOR_DEBT'

export function cursorDebtEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[CURSOR_DEBT_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** The told-set subject the bound line keys on: a path it named, and a rule whose text it gave. */
export const BOUND_TOLD = '#bound'

/** Rule text the bound line gives in full before the rest fall back to bare handles. */
export const BOUND_LINE_BUDGET = 3000

export interface BoundRule {
  handle: string
  rule: string
  /** Already given in full this session or in this call: the handle alone. */
  told: boolean
}

/**
 * The bound line for one edited path. Each rule renders `[handle] "rule"`,
 * whitespace collapsed and never clipped (drift-hardening D2); a rule already
 * told renders as its handle alone, and so does every rule past
 * BOUND_LINE_BUDGET, so the line always names them all.
 */
export function boundLine(rendered: string, rules: readonly BoundRule[]): string {
  let used = 0
  const parts = rules.map((r) => {
    if (r.told) return `[${r.handle}]`
    const part = `[${r.handle}] "${r.rule.replace(/\s+/g, ' ').trim()}"`
    if (used > 0 && used + part.length > BOUND_LINE_BUDGET) return `[${r.handle}]`
    used += part.length
    return part
  })
  const count = rules.length === 1 ? '1 standing rule' : `${rules.length} standing rules`
  return `sofar: Cursor runs no Stop gate, so no test holds this edit — ${rendered} is governed by ${count}: ${parts.join('; ')}.`
}

/** The opening words of a debt note, by which a second sessionEnd finds the first. */
export const DEBT_NOTE_HEAD = 'Unverified edits on rule-bound paths'

/** The head a session's debt note starts with: DEBT_NOTE_HEAD and its short id. */
export function debtNoteHead(session: string): string {
  return `${DEBT_NOTE_HEAD} (Cursor session ${session.slice(0, 8)} `
}

/**
 * The note sessionEnd files for the next session: the session's short id and
 * the gate's own lines, `sofar: ` dropped, in order.
 */
export function debtNoteText(session: string, gateLines: readonly string[]): string {
  const body = gateLines.map((l) => (l.startsWith('sofar: ') ? l.slice('sofar: '.length) : l)).join(' ')
  return `${debtNoteHead(session)}ended with no Stop gate to hold it): ${body}`
}
