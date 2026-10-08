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
  const lower = prompt.toLowerCase()
  const words = slug.split('-').filter((w) => w.length > 0)
  if (words.length === 0) return false
  let from = 0
  for (;;) {
    const at = lower.indexOf(words[0]!, from)
    if (at === -1) return false
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
    if (ok && (i >= lower.length || !wordish(lower[i]!))) return true
  }
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
