import { createHash } from 'node:crypto'

/**
 * Check-suffixed decision handles (r3-fixes 2.6, D18): `D17·k3fz`.
 *
 * `D<n>` is a position in id order, and a union merge of two branches that
 * both logged decisions moves it. The suffix is 4 Crockford base32 chars of
 * sha256 of the decision's event id: a merge never changes it. So a handle
 * copied before a merge still names the decision it named, the way a git
 * short hash does, and one that names nothing is refused. It is a hash of the
 * id, not the id's tail: ULIDs minted in the same millisecond differ only in
 * their last characters.
 *
 * decisions.md prints every entry's handle with its suffix. Round 3's r2
 * Claude session, finding no handle there, counted D-numbers in raw
 * events.jsonl, whose file order a merge had moved, and retired an unrelated
 * entry. Every write path accepts the suffixed form; the stored payload keeps
 * the bare `D<n>` plus the stamped id.
 */

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

/** The separator decisions.md prints between ordinal and suffix. */
export const SUFFIX_SEPARATOR = '·'

/** `D<n>`, optionally `·` or `.` and a 4-char suffix. Case-insensitive suffix. */
const HANDLE_RE = /^D([1-9][0-9]*)(?:[·.]([0-9a-hjkmnp-tv-z]{4}))?$/i

/** 4 Crockford base32 chars of sha256(id): its first 20 bits. */
export function handleSuffix(id: string): string {
  const h = createHash('sha256').update(id, 'utf8').digest()
  const v = (h[0]! << 12) | (h[1]! << 4) | (h[2]! >> 4)
  return CROCKFORD[(v >> 15) & 31]! + CROCKFORD[(v >> 10) & 31]! + CROCKFORD[(v >> 5) & 31]! + CROCKFORD[v & 31]!
}

/** `D<ordinal>·<suffix>` — what decisions.md prints. */
export function suffixedHandle(ordinal: number, id: string): string {
  return `D${ordinal}${SUFFIX_SEPARATOR}${handleSuffix(id)}`
}

/**
 * The handle every agent-facing line prints for a decision of its own record
 * (r4-fixes U5): `D<n>·<sfx>`, never the bare ordinal a merge can move. In
 * round 4 two worktrees both minted D62, and after the merge the Stop gate's
 * "[binwise D62]" named a different rule on main. Bare `D<n>` only when the
 * record holds no decision at that ordinal.
 */
export function handleAt(decisions: ReadonlyArray<{ id: string }>, ordinal: number): string {
  const d = decisions[ordinal - 1]
  return d === undefined ? `D${ordinal}` : suffixedHandle(ordinal, d.id)
}

/** `<slug> D<n>·<sfx>`: a decision named with its record (scope tier, checks, other records' rules). */
export function qualifiedHandle(initiative: string, ordinal: number, id: string): string {
  return `${initiative} ${suffixedHandle(ordinal, id)}`
}

/** A reach node's decision (`decision:<event id>`) as `<slug> D<n>·<sfx>`; `D?` when it carries no ordinal. */
export function reachDecisionHandle(initiative: string, ordinal: number | undefined, nodeId: string): string {
  if (ordinal === undefined) return `${initiative} D?`
  return qualifiedHandle(initiative, ordinal, nodeId.startsWith('decision:') ? nodeId.slice('decision:'.length) : nodeId)
}

/**
 * A recorded `supersedes` (always the bare `D<n>` the fold resolved) as the
 * suffixed handle of the decision it names, when that is an earlier decision
 * of this record; as recorded otherwise.
 */
export function supersedesHandle(decisions: ReadonlyArray<{ id: string }>, raw: string, ordinal: number): string {
  const m = /^D([1-9][0-9]*)$/.exec(raw)
  const n = m === null ? 0 : Number(m[1])
  return n > 0 && n < ordinal ? handleAt(decisions, n) : raw
}

/** What a re-log keeps word for word: everything but the check (r4-fixes U5). */
interface DecisionText {
  id: string
  chose: string
  over: string
  because: string
  rule?: string
  quote?: string
  guard?: string
  until?: string
  superseded_by?: number
}

/** Same words, field for field: a re-log, not a change. The check is not compared. */
export function sameDecisionText(a: DecisionText, b: DecisionText): boolean {
  return (
    a.chose === b.chose &&
    a.over === b.over &&
    a.because === b.because &&
    a.rule === b.rule &&
    a.quote === b.quote &&
    a.guard === b.guard &&
    a.until === b.until
  )
}

/**
 * Re-logs folded into the entry that replaced them (r4-fixes U5). `sofar bind`
 * attaches a check by re-filing a rule word for word with `supersedes` (a check
 * changes only through a ruled superseder), and in round 4 13–24% of a rep's
 * decisions were such copies: agents told the operator "D73 into D76". A
 * decision whose replacer carries the same words (sameDecisionText) is that
 * replacer's ALIAS: every listing renders the pair as one entry, the newer
 * handle first and the older as its alias. Chains fold whole (A re-logged as
 * B, B as C: C carries A and B).
 *
 * `absorbed`: alias ordinal → the ordinal of the entry that renders it.
 * `aliases`: entry ordinal → its alias ordinals, oldest first.
 * Derived from the fold's own supersession marks, never the payload, so a
 * merge that renumbers the record moves both halves together.
 */
export function relogAliases(decisions: ReadonlyArray<DecisionText>): { absorbed: Map<number, number>; aliases: Map<number, number[]> } {
  const next = new Map<number, number>()
  decisions.forEach((d, i) => {
    const by = d.superseded_by
    if (by === undefined || by <= i + 1) return
    const replacer = decisions[by - 1]
    if (replacer !== undefined && sameDecisionText(d, replacer)) next.set(i + 1, by)
  })
  const absorbed = new Map<number, number>()
  const aliases = new Map<number, number[]>()
  for (const from of next.keys()) {
    let to = next.get(from)!
    while (next.has(to)) to = next.get(to)!
    absorbed.set(from, to)
    const list = aliases.get(to) ?? []
    list.push(from)
    aliases.set(to, list)
  }
  return { absorbed, aliases }
}

/** `alias D73·abcd, D76·wxyz` — an entry's aliases as its mark (r4-fixes U5). */
export function aliasMark(decisions: ReadonlyArray<{ id: string }>, ordinals: readonly number[]): string {
  return `alias ${ordinals.map((n) => handleAt(decisions, n)).join(', ')}`
}

export type HandleResolution =
  | { ok: true; ordinal: number; moved?: string }
  | { ok: false; error: string }

/**
 * A typed decision handle in the frame of `decisions` (one record's, in fold
 * order). Null when `raw` is not a handle at all. A bare `D<n>` resolves to
 * n as written — whether it exists is the caller's question, as before. A
 * suffixed one resolves by its suffix: at its ordinal when they agree, else
 * at the one decision carrying that suffix (a merge renumbered the record —
 * `moved` says so); refused when no decision, or more than one elsewhere,
 * carries it.
 */
export function resolveHandle(decisions: ReadonlyArray<{ id: string }>, raw: string): HandleResolution | null {
  const m = HANDLE_RE.exec(raw.trim())
  if (m === null) return null
  const ordinal = Number(m[1])
  const suffix = m[2]?.toLowerCase()
  if (suffix === undefined) return { ok: true, ordinal }
  const at = decisions[ordinal - 1]
  if (at !== undefined && handleSuffix(at.id) === suffix) return { ok: true, ordinal }
  const matches: number[] = []
  decisions.forEach((d, i) => {
    if (handleSuffix(d.id) === suffix) matches.push(i + 1)
  })
  if (matches.length === 1) {
    const n = matches[0]!
    return { ok: true, ordinal: n, moved: `${raw.trim()} is ${handleAt(decisions, n)} now — the record was renumbered (a merge), so its suffix decided` }
  }
  const here = at !== undefined ? `; D${ordinal} here is ${suffixedHandle(ordinal, at.id)}` : ''
  return {
    ok: false,
    error: `${raw.trim()} names no decision in this record${matches.length > 1 ? ` it can tell apart (${matches.map((n) => `D${n}`).join(', ')} share the suffix)` : ''}${here} — copy the handle from decisions.md`,
  }
}

/**
 * A payload's `supersedes` as the bare `D<n>` it names in this frame: a
 * suffixed handle resolved (with `moved` when a merge renumbered it), a bare
 * or non-handle value passed through untouched (the validator judges it).
 * `error` when a suffix names nothing here — the caller refuses.
 */
export function bareSupersedes<T extends { supersedes?: unknown }>(
  decisions: ReadonlyArray<{ id: string }>,
  payload: T,
): { payload: T; moved?: string; error?: string } {
  const raw = payload.supersedes
  if (typeof raw !== 'string') return { payload }
  const r = resolveHandle(decisions, raw)
  if (r === null) return { payload }
  if (!r.ok) return { payload, error: `supersedes: ${r.error}` }
  const bare = `D${r.ordinal}`
  return { payload: bare === raw ? payload : { ...payload, supersedes: bare }, ...(r.moved !== undefined ? { moved: r.moved } : {}) }
}
