import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'

/**
 * The in-band write-back's grammar (r4-fixes A1, SPEC §In-band write-back):
 * the agent's final reply ends with ONE fenced block whose info string is
 * `sofar`, holding the JSON object sofar_end_session takes (summary,
 * next_action, tasks, phases, decisions, memories, notes, brief_append), and
 * the Stop hook files it — no sofar tool call in the session at all. Round 4
 * paid one full-context round trip per sofar MCP call: 37–39 a chain on Codex.
 *
 * This module is the grammar and the bookkeeping only: the switch, finding the
 * block in the final text, parsing it, the `because` cap, the reply text read
 * from a host transcript, and the stash a repair ask leaves. Filing is
 * mcp/inline-writeback.ts, through the same write-back path the tool uses.
 * The native core mirrors exactly two facts from here, both as a superset:
 * a text that may hold a block (`mayHoldBlock`) and a stash on disk
 * (`stashPath`) — on either it hands the hook to this engine (HOTPATH §stop).
 */

/** `SOFAR_WRITEBACK=tool` is the ablation arm: 0.34's tool-only write-back, untouched. */
export type WritebackMode = 'inline' | 'tool'

export function writebackMode(env: NodeJS.ProcessEnv = process.env): WritebackMode {
  return env.SOFAR_WRITEBACK === 'tool' ? 'tool' : 'inline'
}

/**
 * The write-back a host is taught (r4-fixes H5). Claude Code renders the final
 * reply as the operator's last screen and collapses a tool call, so the block
 * there replaced the operator's answer with JSON: it writes back through
 * sofar_end_session. Codex and Cursor, where A1's gain is, keep the block.
 * SOFAR_WRITEBACK=tool or =inline decides for every host.
 */
export function writebackModeFor(tool: string | undefined, env: NodeJS.ProcessEnv = process.env): WritebackMode {
  const set = env.SOFAR_WRITEBACK
  if (set === 'tool' || set === 'inline') return set
  return tool === 'claude-code' ? 'tool' : 'inline'
}

/** The opening fence, alone on its line. */
export const INLINE_FENCE = '```sofar'

/** The write-back grammar's cap on a decision's `because` (1.2 O8: output is 37% of Claude cost). */
export const BECAUSE_MAX = 280

/** How much of a transcript's end is read for the final reply (Cursor carries no reply text in its payload). */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/** May this text hold a block? The native core asks exactly this, so it stays a substring test. */
export function mayHoldBlock(text: string): boolean {
  return text.includes(INLINE_FENCE)
}

export interface InlineBlock {
  /** The lines between the fences, joined with `\n`. */
  body: string
  /** False when no closing fence followed: the reply was cut, or the agent never closed it. */
  closed: boolean
}

/**
 * The LAST block in the text: an opening line that is exactly ```` ```sofar ````
 * (surrounding whitespace aside) and the first line after it that is exactly
 * ```` ``` ````. JSON cannot hold a raw newline inside a string, so no body
 * line can be a fence. An unclosed block runs to the end of the text.
 */
export function extractBlock(text: string): InlineBlock | null {
  if (!mayHoldBlock(text)) return null
  const lines = text.split('\n')
  let open = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.trim() === INLINE_FENCE) {
      open = i
      break
    }
  }
  if (open < 0) return null
  for (let j = open + 1; j < lines.length; j += 1) {
    if (lines[j]!.trim() === '```') return { body: lines.slice(open + 1, j).join('\n'), closed: true }
  }
  return { body: lines.slice(open + 1).join('\n'), closed: false }
}

export interface ParsedBlock {
  /** The block's object, when it parsed as one — still carrying any errors below. */
  value: Record<string, unknown> | null
  /** What keeps it from filing as written: syntax, shape, or a field the write-back refuses. */
  errors: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Parse a block as sofar_end_session's arguments, judged by the same
 * validator the tool's input is (validateToolInput). The session is the one
 * whose reply the block ends, so a `session_id` naming another is an error,
 * never a redirect. Entry-level contracts (a task the plan lacks, a quote
 * with no rule, a reversal) are the write-back planner's, as for the tool.
 */
export function parseBlock(block: InlineBlock, sessionId: string): ParsedBlock {
  let value: unknown
  try {
    value = JSON.parse(block.body)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    const cut = block.closed ? '' : ' — the block has no closing ``` line'
    return { value: null, errors: [`block: not valid JSON (${why})${cut}`] }
  }
  if (!isObj(value)) return { value: null, errors: ['block: must be one JSON object, {"summary":"…","next_action":"…", …}'] }
  const errors: string[] = []
  const check = validateToolInput('sofar_end_session', value)
  if (!check.ok) errors.push(...check.errors)
  if (value.session_id !== undefined && value.session_id !== sessionId) errors.push(sessionMismatch(value.session_id))
  return { value, errors }
}

function sessionMismatch(named: unknown): string {
  return `session_id: ${JSON.stringify(named)} is not this session — leave it out; a block files under the session whose reply it ends`
}

/**
 * A parsed block split for a final filing (no ask left): the top-level fields
 * the tool's validator accepts on their own, and the rest, kept verbatim for a
 * note so nothing the agent wrote is lost. A `session_id` naming another
 * session is dropped — the block still files where its reply ran.
 */
export function splitFields(value: Record<string, unknown>, sessionId: string): { kept: Record<string, unknown>; dropped: Record<string, unknown> } {
  const kept: Record<string, unknown> = {}
  const dropped: Record<string, unknown> = {}
  const base = { summary: 'x', next_action: 'x' }
  for (const [key, field] of Object.entries(value)) {
    const ok = validateToolInput('sofar_end_session', { ...base, [key]: field }).ok && !(key === 'session_id' && field !== sessionId)
    if (ok) kept[key] = field
    else dropped[key] = field
  }
  return { kept, dropped }
}

/**
 * `because` within BECAUSE_MAX: the writer's own whole sentences from the
 * start while they fit (nothing paraphrased, as fitQuote cuts a quote), else
 * the words that fit and an ellipsis. Null when it fits already.
 */
export function capBecause(because: string): string | null {
  if (because.length <= BECAUSE_MAX) return null
  const re = /[^\n.!?;]+[.!?;]*/g
  let end = 0
  for (let m = re.exec(because); m !== null; m = re.exec(because)) {
    const stop = m.index + m[0].trimEnd().length
    if (stop > BECAUSE_MAX) break
    end = stop
  }
  if (end > 0) return because.slice(0, end).trim()
  const room = because.slice(0, BECAUSE_MAX - 1)
  const space = room.lastIndexOf(' ')
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`
}

/** The write result's line for a cut `because`, naming the decision by its handle. */
export function becauseCapWarning(handle: string, filed: string): string {
  return `${handle}'s because was over ${BECAUSE_MAX} chars (the write-back's cap), so it was filed as: "${filed}"`
}

/**
 * The repair ask (exit 2, once): what kept the block from filing. Nothing from
 * it is in the record yet, so the corrected block is sent whole, not a patch.
 */
export function repairAsk(errors: readonly string[]): string {
  return [
    'sofar: your ```sofar write-back did not file — nothing from it is in the record yet. End your reply with the corrected block, whole:',
    ...errors.map((e) => `- ${e}`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The final reply's text.
// ---------------------------------------------------------------------------

/**
 * The text of the final reply a hook payload carries: `last_assistant_message`
 * (Claude Code's and Codex's Stop), else, on Cursor only, the last assistant
 * entry of the transcript its payload names. Claude Code's transcript may lag
 * its own Stop, so it is never read there.
 */
export function finalReplyText(hook: Record<string, unknown>, isCursor: boolean): string | null {
  if (typeof hook.last_assistant_message === 'string') return hook.last_assistant_message
  if (isCursor && typeof hook.transcript_path === 'string' && hook.transcript_path.length > 0) {
    return lastAssistantText(hook.transcript_path)
  }
  return null
}

/** The last TRANSCRIPT_TAIL_BYTES of a file, from the first whole line. Null when unreadable. */
export function transcriptTail(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read)
      if (n === 0) break
      read += n
    }
    const text = buf.subarray(0, read).toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * The text of the last assistant entry in a JSONL transcript's tail: Cursor's
 * `{"role":"assistant","message":{"content":[{"type":"text","text":…}]}}`, or
 * the same message under `"type":"assistant"`. Text parts are joined by a
 * newline; an entry with none (a tool call alone) is skipped.
 */
export function lastAssistantText(path: string): string | null {
  const tail = transcriptTail(path)
  if (tail === null) return null
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim()
    if (line.length === 0) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(entry) || (entry.role !== 'assistant' && entry.type !== 'assistant')) continue
    const message = entry.message
    const content = isObj(message) ? message.content : undefined
    if (typeof content === 'string' && content.length > 0) return content
    if (!Array.isArray(content)) continue
    const texts = content.filter((c): c is { text: string } => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => c.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return null
}

// ---------------------------------------------------------------------------
// The stash a repair ask leaves.
// ---------------------------------------------------------------------------

/** A host session id as a file name: what prompt-buffer.ts sanitizes, per UTF-16 unit. */
export function stashName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

/**
 * Where an asked-about block waits for the next Stop or SessionEnd (derived
 * index, per worktree). It is filed then — the repaired block if one came,
 * else this one, entry by entry — so a session that never answers still
 * loses nothing.
 */
export function stashPath(sofarDir: string, sessionId: string): string {
  return join(indexDir(sofarDir), 'inline', stashName(sessionId))
}

export function readStash(sofarDir: string, sessionId: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(stashPath(sofarDir, sessionId), 'utf8'))
    return isObj(raw) && typeof raw.body === 'string' ? raw.body : null
  } catch {
    return null
  }
}

export function writeStash(sofarDir: string, sessionId: string, body: string): void {
  try {
    ensureIndexDir(sofarDir)
    const path = stashPath(sofarDir, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, `${JSON.stringify({ session: sessionId, body })}\n`)
  } catch {
    // Derived and best-effort: without it the ask still stands, and the agent still holds the block.
  }
}

export function clearStash(sofarDir: string, sessionId: string): void {
  try {
    const path = stashPath(sofarDir, sessionId)
    if (existsSync(path)) rmSync(path, { force: true })
  } catch {
    // A stale stash is filed once and matched as already filed after that.
  }
}
