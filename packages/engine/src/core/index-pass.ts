import { join } from 'node:path'
import type { CorrectionPayload } from '@sofar/schema'
import {
  DEFAULT_META_FILE,
  INDEX_SCHEMA_VERSION,
  readIndexMeta,
  writeIndexMeta,
  type IndexMeta,
  type InitiativeCursor,
} from './index-store'
import { readSince, type IndexedEvent } from './index-tail'
import { initiativeSlugs } from './listing'

/**
 * One incremental pass over every log, shared by every tier (record-index 3.1).
 *
 * Tier 0 shipped with this loop inline. Tier 1 needs the same one, and copying
 * it would have copied the parts that are easy to get wrong rather than the
 * part that is easy to see — so the loop lives here once and a tier supplies
 * only its reducer: what an empty state is, and what one event does to it.
 *
 * Everything hard is in this file, and all of it is about the same question:
 * WHEN IS RESUMING UNSOUND? A cursor makes the common case cheap; these are
 * the four cases where the cheap answer would be the wrong one, each falling
 * back to reading the whole log rather than to a guess.
 *
 * 1. THE CURSOR DOES NOT DESCRIBE THIS FILE — an import, a rewrite, a restore.
 *    Detected by the tail reader's own corroboration (index-tail.ts).
 * 2. THE TAIL IS NOT IN ORDER. The fold replays in ULID order, not file order
 *    (the convergent-fold rule), and `merge=union` on events.jsonl interleaves
 *    two branches' lines — the merge strategy this project chose. Applying
 *    those incrementally would order them differently from every other surface,
 *    so an id that is not above everything already applied forces a rebuild,
 *    and a rebuild sorts by id exactly as the fold does.
 * 3. A CORRECTION VOIDS SOMETHING ALREADY APPLIED. This is the one retroactive
 *    act in an append-only log: `correction` names an event id, and the fold
 *    drops that event wherever it sits. A pass that ignores it keeps reporting
 *    work the record has withdrawn — a session that never really started, a
 *    decision that was taken back. Since applied state cannot be un-applied,
 *    a correction reaching back past the batch rebuilds the log. This record
 *    carries 24 of them, over session_started, session_ended, decision_logged
 *    and command_run, so it is a live case rather than a theoretical one.
 * 4. A LATER EVENT WAS ALREADY VOIDED. Voids are therefore remembered on the
 *    cursor, not just applied to the batch that carried them.
 * 5. THE STATE THE CURSOR DESCRIBES IS GONE. Cursors and derived state live in
 *    different files and can come apart — a lost payload write, a partial
 *    cleanup, a payload missing a slug the meta still has a cursor for. The
 *    cursor is then a position into a state that no longer exists, and
 *    resuming from it reads the tail into an empty state. Absent state
 *    invalidates its own cursor, per slug (record-index 4.2).
 *
 * The cost of being wrong here is silent and permanent, and the cost of being
 * conservative is one re-read of one log. That is the whole trade.
 */

/** What a tier must supply: its per-slug state and how one event changes it. */
export interface SlugReducer<S> {
  /** A fresh state — cold start, or any of the rebuild cases above. */
  empty: () => S
  /** Copy state read from disk, so a resume never mutates it in place. */
  clone: (state: S) => S
  /** Apply one event, exactly as the fold would. */
  apply: (state: S, event: IndexedEvent, slug: string) => void
  /**
   * Whether an event can change this state at all. A batch with none that
   * can is carried by reference and leaves `stateChanged` false, so a tier
   * whose events are rare (memory-lead 3.1, D15: decisions and notes) is not
   * rewritten because a hook appended a command_run. Absent: every event can.
   */
  relevant?: (event: IndexedEvent) => boolean
  /**
   * A RAW-LINE test every line holding an event this tier applies passes
   * (linked-context 4.1). A line failing it is never decoded, so a tier that
   * reads a few event types skips the JSON.parse that is most of a cold pass.
   * Absent: every line is decoded.
   */
  lines?: (line: string) => boolean
}

export interface PassResult<S> {
  /** Per-slug state, for every initiative that exists right now. */
  states: Record<string, S>
  /** False when nothing moved — callers skip writing what has not changed. */
  changed: boolean
  /**
   * False when no state differs from `prior` — the cursors may still have
   * moved (`changed`), but the payload need not be rewritten. Only a reducer
   * with `relevant` can make the two differ.
   */
  stateChanged: boolean
  /**
   * The cursor each log's state now stands at, by slug — absent for a log
   * that held no usable event. Its size and mtime are the fstat of the read
   * that produced the state, so a cache keyed by them names exactly the bytes
   * the state was derived from (the links tier, linked-context 4.1).
   */
  cursors: Record<string, InitiativeCursor>
}

/** The `ref` of a correction, or null when the payload does not carry one. */
function voidedRef(event: IndexedEvent): string | null {
  if (event.type !== 'correction') return null
  const ref = (event.payload as unknown as CorrectionPayload).ref
  return typeof ref === 'string' && ref.length > 0 ? ref : null
}

/** Ids strictly ascending, and all above what has already been applied. */
function inOrder(events: readonly IndexedEvent[], after: string | undefined): boolean {
  let previous = after
  for (const event of events) {
    if (previous !== undefined && event.id <= previous) return false
    previous = event.id
  }
  return true
}

/** Greatest id in a batch, or the prior maximum when the batch is empty. */
function maxIdOf(events: readonly IndexedEvent[], prior: string | undefined): string | undefined {
  let max = prior
  for (const event of events) if (max === undefined || event.id > max) max = event.id
  return max
}

export function passOverRecord<S>(
  sofarDir: string,
  metaFile: string,
  prior: Record<string, S> | null,
  reducer: SlugReducer<S>,
): PassResult<S> {
  const meta: IndexMeta = readIndexMeta(sofarDir, metaFile) ?? {
    version: INDEX_SCHEMA_VERSION,
    cursors: {},
  }
  const states: Record<string, S> = {}
  let changed = prior === null
  let stateChanged = prior === null

  for (const slug of initiativeSlugs(sofarDir)) {
    const log = join(sofarDir, 'initiatives', slug, 'events.jsonl')
    // A CURSOR IS ONLY MEANINGFUL BESIDE THE STATE IT PRODUCED (record-index
    // 4.2). The two live in different files, and the pair can come apart:
    // writeIndexMeta lands before the payload write and both fail silently, a
    // cleanup deletes one, a partial payload is missing a slug the meta still
    // has a cursor for. Trusting the cursor alone then reads only the TAIL into
    // an EMPTY state and persists the result — an index that says a record is
    // empty, stably, until something appends. So absent state invalidates its
    // own cursor, per slug: no prior state means a full read.
    const priorState = prior === null ? undefined : prior[slug]
    const cursor = priorState === undefined ? null : (meta.cursors[slug] ?? null)
    let read = readSince(log, cursor, reducer.lines)
    let voided = new Set(cursor?.voided ?? [])

    // Case 2 and case 3, both of which mean "what I have is not a prefix of
    // what is true". Checked BEFORE anything is applied, so the fallback costs
    // one extra read rather than a corrupted state.
    if (!read.full && read.events.length > 0) {
      const batch = new Set(read.events.map((e) => e.id))
      const reachesBack = read.events.some((e) => {
        const ref = voidedRef(e)
        return ref !== null && !batch.has(ref)
      })
      if (reachesBack || !inOrder(read.events, cursor?.maxId ?? cursor?.id)) {
        read = readSince(log, null, reducer.lines)
      }
    }

    // `priorState === undefined` is now redundant with `read.full` — a null
    // cursor forces a whole-log read above — and is kept because the two say
    // different things: one is "there is nothing to resume from", the other is
    // "nothing was resumed". Losing either would make the pair silently
    // separable again.
    const rebuilt = read.full || priorState === undefined
    if (read.full) voided = new Set() // a rebuild re-derives every void below

    // Corrections first, exactly as the fold's pre-pass does: a correction
    // voids its target wherever that target sits, including later in the same
    // batch. Then replay in ulid order — file order is not normative.
    const events = read.full
      ? [...read.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : read.events

    // A quiet initiative is carried forward BY REFERENCE. `clone` exists so a
    // resume never mutates prior state in place, and with nothing to apply
    // there is nothing to mutate — the copy would be written back byte for
    // byte. It is the difference between O(new events) and O(repo) per
    // refresh: at 1000 initiatives one appended event was deep-copying 50,272
    // path entries, which is most of what the derived half cost to read
    // (record-index 3.3). Safe because `prior` is a fresh parse owned by this
    // call and the states it returns are serialized, never mutated.
    // A batch nothing in which can move this state is quiet too (`relevant`).
    const quiet = events.length === 0 || (reducer.relevant !== undefined && !events.some(reducer.relevant))
    const state = rebuilt
      ? reducer.empty()
      : quiet
        ? priorState!
        : reducer.clone(priorState!)
    for (const event of events) {
      const ref = voidedRef(event)
      if (ref !== null) voided.add(ref)
    }
    // A quiet batch applies nothing: its state is prior's, by reference.
    for (const event of rebuilt || !quiet ? events : []) {
      if (voided.has(event.id)) continue
      reducer.apply(state, event, slug)
    }

    states[slug] = state
    // A rebuild that read nothing (an absent or unreadable log) lands on the
    // same empty state it had, so it is not a change — otherwise a record with
    // one logless initiative would rewrite every index file on every pass.
    if (events.length > 0 || priorState === undefined) changed = true
    else if (read.full && read.cursor !== null) changed = true
    // Lines this tier skips (or cannot use) still move the cursor, and a
    // cursor left behind would re-read the same tail on every pass.
    else if (read.cursor !== null && cursor !== null && (read.cursor.id !== cursor.id || read.cursor.size !== cursor.size)) changed = true
    if (rebuilt || !quiet) stateChanged = true

    if (read.cursor === null) {
      if (meta.cursors[slug] !== undefined) {
        delete meta.cursors[slug]
        changed = true
      }
    } else {
      const next: InitiativeCursor = { ...read.cursor }
      const max = maxIdOf(events, read.full ? undefined : cursor?.maxId)
      if (max !== undefined) next.maxId = max
      if (voided.size > 0) next.voided = [...voided].sort()
      meta.cursors[slug] = next
    }
  }

  // An initiative that vanished must not linger in the cursor map.
  for (const slug of Object.keys(meta.cursors)) {
    if (states[slug] === undefined) {
      delete meta.cursors[slug]
      changed = true
    }
  }
  if (prior !== null && Object.keys(prior).some((slug) => states[slug] === undefined)) {
    changed = true
    stateChanged = true
  }

  if (changed) writeIndexMeta(sofarDir, meta, metaFile)
  return { states, changed, stateChanged, cursors: meta.cursors }
}

export { DEFAULT_META_FILE }
