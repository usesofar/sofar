/**
 * The first-prompt carrier (r4-fixes B14, D25): a fresh session whose first
 * prompt names exactly one open record is homed there, and told so.
 *
 * A10 traced a session's identity (lineage) and the worktree's last home; a
 * fresh session in a checkout bound elsewhere still registered by the branch,
 * and its first events landed in the wrong record until the agent re-homed —
 * 33 sessions since 2026-09-01. The operator's first prompt usually says which
 * record the work belongs to ("continue r4 fixes"); in the replay a prompt
 * naming exactly one open record fixed 11 of the 33, with no wrong move.
 *
 * It qualifies session-orientation D2 for this one case only: the redirect is
 * the operator's words, never a recency guess, and the same line says where
 * the session went and how to move it back.
 */

/** `SOFAR_CARRIER=off` (also `0`, `false`) is the ablation arm. */
export const CARRIER_ENV = 'SOFAR_CARRIER'

export function carrierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[CARRIER_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** The told-set key: the carrier looks at a session's first prompt only. */
export const CARRIER_TOLD_KEY = '%carrier'

/**
 * Whether a slug can be named in prose without colliding with a word: it
 * holds a hyphen or a digit. In the replay a one-word slug (`speed`) matched
 * "speed up my development"; the quick lane never carries.
 */
export function nameable(slug: string): boolean {
  return slug !== 'quick' && /^[a-z0-9-]+$/.test(slug) && (slug.includes('-') || /[0-9]/.test(slug))
}

/**
 * Does the prompt name this slug: its words in order, joined by spaces,
 * hyphens or underscores, case-insensitive, never inside a longer word
 * (`r4 fixes`, `R4-fixes`, `r4_fixes`; never `r4-fixes-2`).
 */
export function promptNames(prompt: string, slug: string): boolean {
  return nameStarts(prompt.toLowerCase(), slug).length > 0
}

/** Where in `lower` (the lowercased prompt) each naming of `slug` starts. */
function nameStarts(lower: string, slug: string): number[] {
  const words = slug.split('-').filter((w) => w.length > 0)
  if (words.length === 0) return []
  const starts: number[] = []
  let from = 0
  for (;;) {
    const at = lower.indexOf(words[0]!, from)
    if (at === -1) return starts
    from = at + 1
    if (at > 0 && wordish(lower[at - 1]!)) continue
    let i = at + words[0]!.length
    let ok = true
    for (const w of words.slice(1)) {
      const sep = i
      while (i < lower.length && (lower[i] === ' ' || lower[i] === '-' || lower[i] === '_' || lower[i] === '\t' || lower[i] === '\n')) i += 1
      if (i === sep || !lower.startsWith(w, i)) {
        ok = false
        break
      }
      i += w.length
    }
    if (ok && (i >= lower.length || !wordish(lower[i]!))) starts.push(at)
  }
}

/**
 * The intent carrier (r4-fixes, superseding D25's first-prompt-only rule):
 * a session that has already worked moves only when the operator says they
 * want to work in the named record, not when it is merely mentioned ("also
 * check the other initiatives, like the R3 fix and R4 fixes" must not move).
 * Intent is one of these words up to INTENT_WINDOW words before the name, in
 * the same sentence, with no negation before it in that window.
 */
export const INTENT_WORDS: readonly string[] = [
  'work', 'working', 'continue', 'continuing', 'switch', 'switching', 'move', 'moving',
  'resume', 'resuming', 'focus', 'focusing', 'task', 'tasks', 'pick', 'rehome', 're-home',
]
export const INTENT_WINDOW = 6
const NEGATIONS: readonly string[] = ['not', "don't", 'dont', 'never', 'no', 'without', 'stop']

/** Does the prompt name `slug` with intent to work there (INTENT_WORDS). */
export function promptIntends(prompt: string, slug: string): boolean {
  const lower = prompt.toLowerCase()
  for (const at of nameStarts(lower, slug)) {
    const before = lower.slice(0, at)
    let cut = -1
    for (const b of ['.', '!', '?', ';', '\n']) cut = Math.max(cut, before.lastIndexOf(b))
    const words = before.slice(cut + 1).split(/[^a-z0-9'-]+/).filter((w) => w.length > 0).slice(-INTENT_WINDOW)
    const cue = words.findIndex((w) => INTENT_WORDS.includes(w))
    if (cue !== -1 && !words.slice(0, cue).some((w) => NEGATIONS.includes(w))) return true
  }
  return false
}

/**
 * The one open record a prompt asks to work in, among `slugs` — null for none
 * or several. Same shape as carriedRecord, with intent in place of a mention.
 */
export function intendedRecord(prompt: string, slugs: readonly string[], open: (slug: string) => boolean): string | null {
  const named = slugs.filter((s) => nameable(s) && promptIntends(prompt, s))
  const live = named.filter(open)
  return live.length === 1 ? live[0]! : null
}

/** A character that continues a word or a slug: ASCII letter, digit, `_` or `-`. */
function wordish(ch: string): boolean {
  return /[a-z0-9_-]/.test(ch)
}

/**
 * The one record a prompt names, among `slugs`, that `open` admits — null for
 * none or several. Names are matched first (no fold); `open` is asked only of
 * the names that matched.
 */
export function carriedRecord(prompt: string, slugs: readonly string[], open: (slug: string) => boolean): string | null {
  const named = slugs.filter((s) => nameable(s) && promptNames(prompt, s))
  const live = named.filter(open)
  return live.length === 1 ? live[0]! : null
}

/** What the session is told, first, when the carrier moved it. */
export function carrierLine(from: string, to: string, sessionId: string): string {
  return (
    `sofar: your prompt names the record ${to}, so this session now serves ${to} (the branch gave it ${from}). ` +
    `Any record block injected above is ${from}'s — read ${to}'s with sofar_get_state({"initiative":"${to}"}). ` +
    `If ${to} is wrong, sofar_start_session({"session_id":"${sessionId}","initiative":"${from}"}) moves it back.`
  )
}

/** What the session is told, first, when the intent carrier moved it. */
export function intentLine(from: string, to: string, sessionId: string): string {
  return (
    `sofar: your prompt asks to work on ${to}, so this session now serves ${to} (it served ${from}). ` +
    `Hooks, write-backs and the Stop gate follow ${to} from here; read its state with sofar_get_state({"initiative":"${to}"}). ` +
    `If ${to} is wrong, sofar_start_session({"session_id":"${sessionId}","initiative":"${from}"}) moves it back.`
  )
}
