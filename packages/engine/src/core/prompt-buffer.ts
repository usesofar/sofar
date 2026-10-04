import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CapturedPromptRow } from '@sofar/schema'
import { redactProse } from './redact'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * The prompt buffer (r3-fixes 2.9, D6): every operator prompt, verbatim, in a
 * private per-clone file OUTSIDE the repo, so the brief can grow by reference.
 *
 * Round 3's agents kept the operator's words by retyping them into a full
 * plan_updated each session — 0.70–0.81M chars of brief a chain, re-read from
 * the log to be resent. Here the prompt hook files each prompt as `P<n>` (the
 * n-th prompt of its session) and tells the agent the id; a write-back that
 * keeps the id has sofar copy the text into brief_appended. Nothing reaches
 * the committed record unless it is kept, which is the privacy line D6 draws:
 * a pasted secret stays in a file only this user can read, swept after
 * PROMPT_RETENTION_DAYS, never in an append-only log.
 *
 * Best-effort like every hook write (BD22): a failure files nothing and the
 * hook says nothing, and the agent falls back to appending the words.
 */

/** A prompt shorter than this is cheaper to retype than to announce, so its id is not offered. */
export const PROMPT_ANNOUNCE_MIN = 100
/** Session files untouched this long are deleted when a new session's file is made. */
export const PROMPT_RETENTION_DAYS = 30
const OFF_MARKER = 'off'
export const PROMPT_ID_RE = /^P([1-9][0-9]*)$/

/** This clone's buffer directory, or null when it would sit inside the repo (XDG_STATE_HOME there). */
export function promptBufferDir(rootDir: string, env: StateEnv = process.env): string | null {
  const dir = join(stateBase(env), 'prompts', cloneKey(rootDir))
  return resolvesInside(dir, rootDir) ? null : dir
}

/** Session ids come from the host; sanitized the way diagnostics names are. */
function sessionFile(dir: string, sessionId: string): string {
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
}

/** Off by `SOFAR_PROMPT_CAPTURE=off` (the ablation switch) or this clone's `sofar init --no-prompt-capture`. */
export function promptCaptureEnabled(rootDir: string, env: StateEnv = process.env): boolean {
  if (env.SOFAR_PROMPT_CAPTURE === 'off') return false
  const dir = promptBufferDir(rootDir, env)
  return dir !== null && !existsSync(join(dir, OFF_MARKER))
}

/** `sofar init --[no-]prompt-capture`: the per-clone marker, nothing in the repo. */
export function setPromptCapture(rootDir: string, on: boolean, env: StateEnv = process.env): void {
  const dir = promptBufferDir(rootDir, env)
  if (dir === null) return
  const marker = join(dir, OFF_MARKER)
  if (on) rmSync(marker, { force: true })
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(marker, '', { mode: 0o600 })
  }
}

function readRows(path: string): CapturedPromptRow[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const rows: CapturedPromptRow[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const row = JSON.parse(line) as Partial<CapturedPromptRow>
      if (typeof row.id === 'string' && typeof row.ts === 'string' && typeof row.text === 'string') rows.push(row as CapturedPromptRow)
    } catch {
      // A torn line is skipped; the next prompt still numbers after it.
    }
  }
  return rows
}

/** Delete session files untouched for PROMPT_RETENTION_DAYS. */
function sweep(dir: string, nowMs: number): void {
  const cutoff = nowMs - PROMPT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const path = join(dir, name)
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    } catch {
      // Raced or unreadable: the next sweep tries again.
    }
  }
}

/**
 * File one prompt; returns its id, or null when capture is off or the write
 * failed. The same text as the session's last prompt is the same prompt (a
 * host that fires the hook twice), so it keeps that id.
 */
export function capturePrompt(rootDir: string, sessionId: string, text: string, ts: string, env: StateEnv = process.env): string | null {
  if (text.length === 0 || !promptCaptureEnabled(rootDir, env)) return null
  const dir = promptBufferDir(rootDir, env)!
  const path = sessionFile(dir, sessionId)
  try {
    const rows = readRows(path)
    const last = rows[rows.length - 1]
    if (last !== undefined && last.text === text) return last.id
    if (rows.length === 0) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      sweep(dir, Date.parse(ts))
    }
    const id = `P${rows.length + 1}`
    const row: CapturedPromptRow = { id, ts, text }
    appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    return id
  } catch {
    return null
  }
}

/** A prompt this session captured, by id; null when there is none. */
export function capturedPrompt(rootDir: string, sessionId: string, id: string, env: StateEnv = process.env): CapturedPromptRow | null {
  const dir = promptBufferDir(rootDir, env)
  if (dir === null) return null
  return readRows(sessionFile(dir, sessionId)).find((row) => row.id === id) ?? null
}

/** The line that offers a long prompt's id to the agent. */
export function promptKeepLine(id: string): string {
  return `sofar: this prompt is ${id} — if it is roadmap or spec, keep it in the brief by id at write-back (brief_append ["${id}"]); sofar copies it verbatim.`
}

/**
 * The brief text a kept prompt becomes: a dated header, then the prompt
 * verbatim with secrets scrubbed (redactProse). The header is the shape round
 * 3's agents typed by hand ("--- Session 9 …, the operator's words verbatim
 * ---"), minus the session number they kept getting wrong.
 */
export function keptPromptText(row: CapturedPromptRow): string {
  return `--- Operator, ${row.ts.slice(0, 10)} ---\n\n${redactProse(row.text)}`
}

/**
 * One brief_append entry as the text to file: a `P<n>` this session captured
 * becomes its kept text; any other entry is the words themselves. An id with
 * no capture behind it is null — the caller says so, and files the rest.
 */
export function briefEntryText(rootDir: string, sessionId: string, entry: string, env: StateEnv = process.env): string | null {
  if (!PROMPT_ID_RE.test(entry)) return entry
  const row = capturedPrompt(rootDir, sessionId, entry, env)
  return row === null ? null : keptPromptText(row)
}

/** What a write path says for a `P<n>` with no capture behind it: nothing filed, words still welcome. */
export function uncapturedWarning(where: string, id: string): string {
  return `${where}: no prompt ${id} was captured in this session (capture off, another session's id, or a host that sends no prompt) — nothing filed for it; append the operator's words instead`
}
