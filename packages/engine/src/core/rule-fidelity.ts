/**
 * Rule fidelity (memory-lead 1.2, D2) — what a standing rule states that the
 * operator's own words do not.
 *
 * A rule is the agent's restatement of something the operator said, and a
 * restatement can add law nobody made: round 1's claude-sofar wrote "reject
 * anything else with 4xx" for an operator's "Reject anything else", the digest
 * told every later session to obey the rule verbatim, and S9 returned a 400 the
 * tests did not want. The decision now carries the operator's `quote`, and
 * this module names the SPECIFICS the rule adds — the concrete, checkable
 * tokens a paraphrase slips in:
 *
 *  - status: an HTTP status code or class — `400`, `4xx`;
 *  - path:   a token with `/` between path characters (`apps/web`, `/api`),
 *            or a file name with an extension (`categories.ts`);
 *  - value:  a backticked or double-quoted span, or any other token carrying
 *            a digit (`30s`, `6`, `v2`) — decision and memory handles (`D3`,
 *            `M2`) excepted, since those cite the record, not the world.
 *
 * Pure and deterministic: no env, no clock, no locale — the digest renders
 * from it, and rust-core mirrors the digest byte for byte (memory-lead 1.4).
 * Matching is case-insensitive over whitespace-collapsed text, and a term
 * whose edge is alphanumeric must meet a non-alphanumeric boundary in the
 * quote, so `400` is not found inside `4000`.
 */

export type RuleSpecificKind = 'status' | 'path' | 'value'

export interface RuleSpecific {
  kind: RuleSpecificKind
  text: string
}

/** Backticked and double-quoted spans (straight or curly), inner text captured. */
const SPAN_RE = /`([^`]+)`|"([^"]+)"|“([^”]+)”/g
const LEADING_PUNCT = /^[([{<'"‘“]+/
const TRAILING_PUNCT = /[)\]}>'"’”,;:.!?]+$/
const STATUS_RE = /^(?:[1-5][0-9]{2}|[1-5]xx)$/i
const SLASH_PATH_RE = /[\w.~-]\/[\w.*-]|^\/[\w.-]/
const FILE_NAME_RE = /^[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}$/
const HANDLE_RE = /^[DM][1-9][0-9]*$/

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

function classify(token: string): RuleSpecificKind | null {
  if (STATUS_RE.test(token)) return 'status'
  if (SLASH_PATH_RE.test(token) || FILE_NAME_RE.test(token)) return 'path'
  if (/[0-9]/.test(token) && !HANDLE_RE.test(token)) return 'value'
  return null
}

/** Every specific the rule states, in rule order, deduplicated case-insensitively. */
export function ruleSpecifics(rule: string): RuleSpecific[] {
  const found: RuleSpecific[] = []
  const seen = new Set<string>()
  const add = (kind: RuleSpecificKind, text: string): void => {
    const key = text.toLowerCase()
    if (text.length === 0 || seen.has(key)) return
    seen.add(key)
    found.push({ kind, text })
  }

  // Spans first, then the text between them, so a span's words are never
  // re-read as tokens and the output stays in the order the rule reads.
  let last = 0
  const tokensOf = (chunk: string): void => {
    for (const raw of chunk.split(/\s+/)) {
      const token = raw.replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '')
      const kind = token.length > 0 ? classify(token) : null
      if (kind !== null) add(kind, token)
    }
  }
  for (const m of rule.matchAll(SPAN_RE)) {
    tokensOf(rule.slice(last, m.index))
    add('value', collapse(m[1] ?? m[2] ?? m[3] ?? ''))
    last = m.index! + m[0].length
  }
  tokensOf(rule.slice(last))
  return found
}

const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch)

/** `needle` occurs in `haystack` (both lowercased) at a term boundary. */
function containsTerm(haystack: string, needle: string): boolean {
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    const before = isAlnum(needle[0]) && isAlnum(haystack[at - 1])
    const after = isAlnum(needle[needle.length - 1]) && isAlnum(haystack[at + needle.length])
    if (!before && !after) return true
    at = haystack.indexOf(needle, at + 1)
  }
  return false
}

/** The specifics the rule states and the quote does not, as the rule spells them. */
export function unquotedSpecifics(rule: string, quote: string): string[] {
  const words = collapse(quote).toLowerCase()
  return ruleSpecifics(rule)
    .filter((s) => !containsTerm(words, collapse(s.text).toLowerCase()))
    .map((s) => s.text)
}

/**
 * The rule as every surface renders it: verbatim, then — when the decision
 * carries one — the operator's words and what the rule adds to them.
 * Whitespace is collapsed (normalization, not clipping: nothing is cut).
 */
export function renderRule(rule: string, quote: string | undefined): string {
  const text = collapse(rule)
  return quote === undefined ? text : `${text} — ${quoteClause(rule, quote)}`
}

/** `operator: "<quote>"`, plus what the rule adds to it — the half after the rule. */
export function quoteClause(rule: string, quote: string): string {
  const added = unquotedSpecifics(rule, quote)
  const flag = added.length > 0 ? ` (not in the operator's words: ${added.join(', ')})` : ''
  return `operator: "${collapse(quote)}"${flag}`
}

/**
 * The write-time warning (D2): the capturing session learns what its rule
 * adds while the operator's message is still in its context — the one moment
 * a correction costs nothing but the next call. Null when nothing is added.
 * `handle` is the decision's check-suffixed handle (r4-fixes U5).
 */
export function ruleFidelityWarning(handle: string, rule: string, quote: string | undefined): string | null {
  if (quote === undefined) return null
  const added = unquotedSpecifics(rule, quote)
  if (added.length === 0) return null
  return (
    `${handle}'s rule states ${added.join(', ')}, which the operator's quote does not. ` +
    `Every digest flags it; if the operator did not say it, log the rule as they worded it with supersedes ${handle}.`
  )
}
