/**
 * The citation grammar (record-graph 1.3), split into SCAN and BIND
 * (record-index 3.4).
 *
 * It lived in core/graph.ts, which the hot-path lock keeps every hook, shim,
 * projection and MCP module away from — and the reach index needs the same
 * grammar to answer "which decisions does this one point at". So the rule moves
 * DOWN, exactly as adjacency.ts moved down below the fold, and core/graph.ts
 * re-exports it unchanged for the callers that already had it.
 *
 * The split is not cosmetic. Scanning is lexical and depends on nothing outside
 * the text; BINDING a qualifier depends on which initiatives exist, which is a
 * repo-wide fact that CHANGES — `sofar new` makes a word that qualified nothing
 * yesterday qualify today. An index that resolved at write time would freeze
 * that answer and quietly disagree with the graph forever after. So the index
 * stores the scan (permanent, per-event) and binds at query time (current, by
 * construction).
 */

/** How much of a title its anchor compares — REACH_PROSE (core/index-reach.ts). */
export const TITLE_KEY_PROSE = 300

/**
 * The text a title anchor compares: whitespace-collapsed and clipped, as the
 * reach index stores the title. A task title cite anchors at the event that
 * last CHANGED this text (linked-context D13), so reach, buildGraph and the
 * links tier all read it from here — a restating plan replace moves none.
 */
export function titleKey(title: string): string {
  const oneLine = title.replace(/\s+/g, ' ').trim()
  return oneLine.length <= TITLE_KEY_PROSE ? oneLine : `${oneLine.slice(0, TITLE_KEY_PROSE - 1)}…`
}

/** One handle-shaped token found in prose, before any initiative is known. */
export interface ScannedCitation {
  /** The word directly before the handle — a qualifier ATTEMPT, often ''. */
  word: string
  /** Whitespace between word and handle, kept so `raw` reproduces the source. */
  gap: string
  /** `D<n>`, `T<n>`, `M<n>` (opt-in), or `<n>.<n>`. */
  handle: string
}

/** A scanned handle bound to an initiative. */
export interface Citation {
  /** The matched text, verbatim — what a dangling report shows. */
  raw: string
  /** Initiative the handle is scoped to: the qualifier, or the citing record's own slug. */
  slug: string
  /** `D<n>`, `T<n>`, `<n>.<n>`, or — qualified only — `M<n>`. */
  handle: string
  /** True when the slug came from an explicit qualifier rather than the default. */
  qualified: boolean
}

/**
 * Find every handle-shaped token in prose. Lexical, closed, and independent of
 * which initiatives exist.
 *
 * The word directly before the handle is captured separately from the handle
 * itself so a handle-shaped word (`D3 D4`) cannot be consumed as a failed
 * qualifier and lost as a citation.
 *
 * `M<n>` (a promoted memory) is OFF by default. The repo.md scan, the reach
 * index and buildGraph turn it on (linked-context 3.3); binding then drops every
 * UNQUALIFIED one (bindHandle), so a bare `M1` naming a milestone never binds.
 */
export function scanCitations(text: string, options: { memories?: boolean } = {}): ScannedCitation[] {
  const pattern =
    options.memories === true ? /\b(D\d+|T\d+|M\d+|\d+\.\d+)\b/g : /\b(D\d+|T\d+|\d+\.\d+)\b/g
  const scanned: ScannedCitation[] = []
  for (const match of text.matchAll(pattern)) {
    const attempt = /([A-Za-z0-9-]+)([ \t]+)$/.exec(text.slice(0, match.index ?? 0))
    scanned.push({ word: attempt?.[1] ?? '', gap: attempt?.[2] ?? '', handle: match[1]! })
  }
  return scanned
}

/** Known slugs, folded for case-insensitive qualifier binding. */
export function canonicalSlugs(knownSlugs: readonly string[]): Map<string, string> {
  return new Map(knownSlugs.map((slug) => [slug.toLowerCase(), slug]))
}

/**
 * Bind ONE scanned handle to the initiative it names, or null when it is not a
 * citation at all.
 *
 * QUALIFIED `<slug> <handle>` binds to that initiative; UNQUALIFIED
 * `D<n>`/`T<n>` binds to the citing record's own. A bare `<n>.<n>` is NOT a
 * handle: measured over the live record it matches version strings (`0.1`,
 * `0.7`, `0.8`) and an IP octet (`127.0`) and nothing true.
 *
 * Qualifier binding is CASE-INSENSITIVE (record-graph 5.1). Slugs are lowercase
 * by construction, so `Felt-cost D3` at a sentence start is orthography, not a
 * different name — and an exact-match rule would not leave it unbound: the
 * handle would silently degrade to an UNQUALIFIED `D3` and bind to the citing
 * record's own initiative, a manufactured edge.
 *
 * `M<n>` is QUALIFIED-ONLY (linked-context D3): memory ordinals are
 * per-initiative and prose uses bare `M<n>` for milestones, so an unqualified
 * one is not a handle — it never binds home and never dangles.
 */
export function bindHandle(
  scan: ScannedCitation,
  homeSlug: string,
  canonical: ReadonlyMap<string, string>,
): Citation | null {
  const slug = scan.word === '' ? undefined : canonical.get(scan.word.toLowerCase())
  // A dotted task id without its slug is not a handle.
  if (slug === undefined && scan.handle.includes('.')) return null
  // Nor is a memory ordinal (linked-context D3).
  if (slug === undefined && scan.handle.startsWith('M')) return null
  return {
    raw: slug === undefined ? scan.handle : `${scan.word}${scan.gap}${scan.handle}`,
    slug: slug ?? homeSlug,
    handle: scan.handle,
    qualified: slug !== undefined,
  }
}

/**
 * Extract citation handles from prose — scan, then bind.
 *
 * `BD<n>` and `D-<label>` are not in the grammar at all: they name the archived
 * pre-migration prose record and hand-coined labels, which have no nodes here,
 * and resolving them would require inference (felt-cost D3). Only a space or
 * tab may separate qualifier from handle, so a slug ending one field cannot
 * bind to a handle opening the next.
 */
export function extractCitations(
  text: string,
  homeSlug: string,
  knownSlugs: readonly string[],
  options: { memories?: boolean } = {},
): Citation[] {
  if (knownSlugs.length === 0) return []
  const canonical = canonicalSlugs(knownSlugs)
  const citations: Citation[] = []
  for (const scan of scanCitations(text, options)) {
    const citation = bindHandle(scan, homeSlug, canonical)
    if (citation !== null) citations.push(citation)
  }
  return citations
}
