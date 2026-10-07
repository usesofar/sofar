import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from '../core/state-dir'
import type { AgentId } from './agents'

/**
 * The wiring journal (r4-fixes R12, A11): one JSON line per `sofar init`,
 * `sofar uninit`, `sofar doctor --fix` and `sofar upgrade` run that changed
 * anything, naming who ran it (argv, cwd, terminal or not), the agents it
 * resolved, and every file written or removed with its hash.
 *
 * It is also the consent set (A11; R12 amends r1-fixes D36's "no stored
 * selection" for audit and consent only): an agent is chosen in this clone
 * when a journal line records an explicit choice of it — `--agents`, or a
 * picker confirmation — and no later uninit removed it. A rerun that does not
 * name its agents (`--refresh`, or no terminal) rewrites only wired agents
 * that are chosen, so a host this clone never chose is never written, even
 * when its files arrived some other way (a teammate's commit, an older sofar).
 * A clone whose journal predates consent (no 0.35 line yet) has every wired
 * agent standing as chosen until its first new line, which records that set
 * as `adopted` — the bridge that keeps existing repos refreshing.
 *
 * It lives in the per-user state dir (`<state>/wiring/<clone key>.jsonl`), so
 * no path under the repo is produced and nothing can be committed; when that
 * dir would resolve inside the clone, nothing is journaled (self-improve D3).
 */

/** The commands that journal (A11). Absent on 0.34.1's lines, which were all init runs. */
export type WiringCommand = 'init' | 'uninit' | 'doctor --fix' | 'upgrade'

/** How an init run's agents were chosen. `flag` and `picker` are explicit choices; the others rewire what is chosen. */
export type WiringSelection = 'flag' | 'refresh' | 'wired' | 'picker'

export interface WiringFile {
  /** Relative to the root when inside it (POSIX separators), else absolute — a worktree's git hook lives in the common git dir. */
  path: string
  op: 'write' | 'remove'
  /** sha256 of the bytes written; absent for a removal. */
  sha256?: string
  /** The write created the file (A11): `uninit --agent` deletes it again when reversing leaves it empty. */
  created?: true
}

export interface WiringEntry {
  ts: string
  sofar: string
  root: string
  cwd: string
  argv: string[]
  tty: boolean
  /** A11; absent means init (0.34.1). */
  command?: WiringCommand
  /** init only. */
  selection?: WiringSelection
  /** init: the agents it wired; uninit: the agents it removed; doctor --fix and upgrade: the agents wired at the time. */
  agents: AgentId[]
  /** The wired agents this clone's first consent-era line recorded as already chosen (the bridge). */
  adopted?: AgentId[]
  /** init: wired agents left as they were because no line records choosing them. */
  skipped?: AgentId[]
  /** upgrade: the versions it moved between. */
  upgrade?: { from: string; to: string }
  result: 'ok' | 'aborted'
  files: WiringFile[]
}

/** `<state>/wiring/<clone key>.jsonl`; null when the state dir would sit inside the clone. */
export function wiringJournalPath(rootDir: string, env: StateEnv = process.env): string | null {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) return null
  return join(base, 'wiring', `${cloneKey(rootDir)}.jsonl`)
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** A written path as the journal names it. */
export function journalPath(rootDir: string, path: string): string {
  const rel = relative(rootDir, path)
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  return inside ? rel.split('\\').join('/') : path
}

/** Append one entry. Never throws: a journal that cannot be written must not fail the run that wired. */
export function appendWiringEntry(rootDir: string, entry: WiringEntry, env: StateEnv = process.env): void {
  try {
    const path = wiringJournalPath(rootDir, env)
    if (path === null) return
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // audit only — the wiring itself already happened
  }
}

/** One readable entry and its 1-based line in the journal file, which is how doctor cites it. */
export interface JournalLine {
  line: number
  entry: WiringEntry
}

/** Every readable entry with its line number, oldest first; a corrupt line is skipped, never fatal. */
export function readWiringJournalLines(rootDir: string, env: StateEnv = process.env): JournalLine[] {
  const path = wiringJournalPath(rootDir, env)
  if (path === null || !existsSync(path)) return []
  const out: JournalLine[] = []
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (text.trim().length === 0) return
      try {
        out.push({ line: i + 1, entry: JSON.parse(text) as WiringEntry })
      } catch {
        // skipped
      }
    })
  return out
}

/** Every readable entry, oldest first; a corrupt line is skipped, never fatal. */
export function readWiringJournal(rootDir: string, env: StateEnv = process.env): WiringEntry[] {
  return readWiringJournalLines(rootDir, env).map((l) => l.entry)
}

/** The line that stands for an agent's choice, and how it was made. */
export interface ConsentChoice extends JournalLine {
  how: 'chosen' | 'adopted'
}

export interface Consent {
  /** A consent-era (0.35+) line exists; until one does, every wired agent stands as chosen (the bridge). */
  recorded: boolean
  /** Agents with a standing choice, each with the line that made it. */
  chosen: Map<AgentId, ConsentChoice>
}

/**
 * Fold the journal into the consent set: `adopted` and explicit init choices
 * grant, an uninit's agents revoke, in line order. What closes the bridge is
 * a line that says what is chosen — one carrying `adopted`, an explicit choice
 * written in this format, or an uninit; doctor --fix and upgrade lines say
 * nothing about it. 0.34.1's explicit choices grant too, but leave the bridge
 * open: they recorded no adoption, so they cannot say which other wired
 * agents were chosen.
 */
export function consentOf(lines: readonly JournalLine[]): Consent {
  let recorded = false
  const chosen = new Map<AgentId, ConsentChoice>()
  for (const l of lines) {
    const { entry } = l
    if (entry.result !== 'ok') continue
    if (entry.adopted !== undefined) recorded = true
    for (const id of entry.adopted ?? []) chosen.set(id, { ...l, how: 'adopted' })
    const command = entry.command ?? 'init'
    if (command === 'init' && (entry.selection === 'flag' || entry.selection === 'picker')) {
      if (entry.command !== undefined) recorded = true
      for (const id of entry.agents) chosen.set(id, { ...l, how: 'chosen' })
    } else if (command === 'uninit') {
      recorded = true
      for (const id of entry.agents) chosen.delete(id)
    }
  }
  return { recorded, chosen }
}

/** This clone's consent set, read from its journal. */
export function readConsent(rootDir: string, env: StateEnv = process.env): Consent {
  return consentOf(readWiringJournalLines(rootDir, env))
}

/**
 * The wired agents a run that names none may rewrite: the chosen ones, or
 * every wired one before the first consent-era line. `SOFAR_CONSENT=off` is
 * the ablation switch: every wired agent, as 0.34.1 did (the journal is still
 * written, and doctor still reads it).
 */
export function consentedWired(
  wired: readonly AgentId[],
  consent: Consent,
  env: Record<string, string | undefined> = process.env,
): AgentId[] {
  if (env.SOFAR_CONSENT === 'off') return [...wired]
  return consent.recorded ? wired.filter((id) => consent.chosen.has(id)) : [...wired]
}

/** What the journal says sofar last wrote at a path still standing: its hash, and whether a sofar write created it. */
export interface LedgerFile {
  sha256: string | undefined
  created: boolean
  line: number
}

/**
 * The files sofar wrote in this clone and has not removed since, by journal
 * path — what `sofar uninit --agent` may reverse, and nothing else. `created`
 * holds from the write that brought a path into being until a removal.
 */
export function writtenFiles(lines: readonly JournalLine[]): Map<string, LedgerFile> {
  const out = new Map<string, LedgerFile>()
  for (const { line, entry } of lines) {
    for (const f of entry.files) {
      if (f.op === 'remove') {
        out.delete(f.path)
        continue
      }
      const prior = out.get(f.path)
      out.set(f.path, { sha256: f.sha256, created: prior?.created ?? f.created === true, line })
    }
  }
  return out
}
