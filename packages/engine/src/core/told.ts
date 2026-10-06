import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'

/**
 * What a session has already been told (memory-lead 2.1, D6): one entry per
 * (decision, subject) that a PostToolUse notice named, on a read or an edit.
 *
 * Reads append nothing to the record, so unlike the edit's lastTouch there is
 * no event to reconstruct this from. It lives in the derived index instead,
 * which makes it disposable in the safe direction: a lost, corrupt or raced
 * file re-tells a decision and never silences one. SessionStart deletes the
 * file on `compact` and `clear`, because the context that held the notices is
 * gone.
 */

const TOLD_DIR = 'told'
const TOLD_VERSION = 1

/** One told pair. The subject is the repo-relative path the notice named. */
export function toldKey(decisionId: string, subject: string): string {
  return `${decisionId} ${subject}`
}

function toldFile(sofarDir: string, session: string): string {
  return join(indexDir(sofarDir), TOLD_DIR, `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

/** The pairs this session was told; empty for `cli` or when nothing usable is on disk. */
export function readTold(sofarDir: string, session: string): Set<string> {
  if (session === 'cli') return new Set()
  try {
    const raw = JSON.parse(readFileSync(toldFile(sofarDir, session), 'utf8')) as { v?: unknown; told?: unknown }
    if (raw.v !== TOLD_VERSION || !Array.isArray(raw.told)) return new Set()
    return new Set(raw.told.filter((k): k is string => typeof k === 'string'))
  } catch {
    return new Set()
  }
}

/** Add pairs to the session's set. Silent on failure: the cost of a lost write is one repeat. */
export function addTold(sofarDir: string, session: string, keys: readonly string[]): void {
  if (session === 'cli' || keys.length === 0) return
  try {
    const told = readTold(sofarDir, session)
    for (const key of keys) told.add(key)
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), TOLD_DIR), { recursive: true })
    writeFileAtomic(toldFile(sofarDir, session), `${JSON.stringify({ v: TOLD_VERSION, told: [...told] })}\n`)
  } catch {
    // See the header: a set that cannot be written re-tells.
  }
}

/** Forget what the session was told, because its context was compacted or cleared. */
export function clearTold(sofarDir: string, session: string): void {
  try {
    rmSync(toldFile(sofarDir, session), { force: true })
  } catch {
    // Nothing to forget.
  }
}

// ---------------------------------------------------------------------------
// Fragments with validity epochs (r4-fixes A4; R4-RESEARCH 1.2 O6, N5).
// ---------------------------------------------------------------------------

/**
 * Every hook line is a fragment told once per validity epoch, not once per
 * hook call. Round 4's Codex sessions carried 10.5 notices a session, 38% of
 * them naming only rules already shown (one rule ×8, once per test file read);
 * the 4.1 Claude ones repeated 20%, and the recall block re-sent 21% of what
 * the digest had just said.
 *
 * - An ENTRY (a decision or memory, by event id) whose text the digest, the
 *   recall block or a notice put in this context is `@<id>`; a notice that
 *   told it at the point of use adds `!<id>`. The rule's head IS the epoch:
 *   a supersession is a new id, so its replacement is told afresh.
 * - A STATE line (push state, the debt nudge) is one `<name>=<epoch>` key,
 *   replaced when the epoch moves.
 * - Compaction and /clear delete the set (SessionStart), every epoch with it.
 *
 * `SOFAR_TOLD_LINES=off` is the ablation arm: 0.34's per-(entry, path) set,
 * stateless push and debt lines, no seeding.
 */
export const TOLD_LINES_ENV = 'SOFAR_TOLD_LINES'

export function toldLinesEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[TOLD_LINES_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** An entry whose text this context holds (digest, recall or a notice). */
export const entryToldKey = (id: string): string => `@${id}`
/** An entry a notice already told at the point of use. */
export const pointToldKey = (id: string): string => `!${id}`

/** The epoch a state fragment was last told at, or null. */
export function fragmentEpoch(told: ReadonlySet<string>, name: string): string | null {
  const prefix = `${name}=`
  for (const key of told) if (key.startsWith(prefix)) return key.slice(prefix.length)
  return null
}

/** Set a state fragment's epoch (null forgets it). Silent on failure, like addTold: a lost write re-tells. */
export function setFragment(sofarDir: string, session: string, name: string, epoch: string | null): void {
  if (session === 'cli') return
  try {
    const prefix = `${name}=`
    const told = [...readTold(sofarDir, session)].filter((key) => !key.startsWith(prefix))
    if (epoch !== null) told.push(`${prefix}${epoch}`)
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), TOLD_DIR), { recursive: true })
    writeFileAtomic(toldFile(sofarDir, session), `${JSON.stringify({ v: TOLD_VERSION, told })}\n`)
  } catch {
    // A set that cannot be written re-tells.
  }
}

/**
 * The event ids of this record's entries a rendered digest put in context:
 * every `- [D<n>…]` and `- [M<n>]` line it holds (window, rejected ledger,
 * standing constraints, memory). Other records' entries (`[<slug> D<n>]`)
 * are not this state's to name.
 */
export function renderedEntryIds(
  state: { decisions: ReadonlyArray<{ id: string }>; memories: ReadonlyArray<{ id: string }> },
  text: string,
): string[] {
  const ids: string[] = []
  for (const line of text.split('\n')) {
    const m = /^- \[([DM])([1-9][0-9]{0,5})(?:·[0-9a-z]{4})?\]/.exec(line)
    if (m === null) continue
    const entry = (m[1] === 'D' ? state.decisions : state.memories)[Number(m[2]) - 1]
    if (entry !== undefined && !ids.includes(entry.id)) ids.push(entry.id)
  }
  return ids
}

/** The debt nudge's band (r4-fixes A4): 5–9 → 5, 10–19 → 10, 20–39 → 20 … — told once per band. */
export function debtBand(debt: number): number {
  let band = 5
  while (band * 2 <= debt) band *= 2
  return band
}
