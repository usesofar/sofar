import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/**
 * Where a hook can read a Claude Code session's live context size, and the
 * model's window (context-ceiling 1.1). Verified against Claude Code 2.1.296.
 *
 * TWO sources, and only one carries the window:
 *
 * - The statusline's stdin, on every render: `context_window.current_usage`
 *   (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`),
 *   `context_window.context_window_size` and `context_window.used_percentage`.
 *   This is the ONLY place the window is stated.
 * - The transcript (`transcript_path` on every hook's stdin): each main-chain
 *   `type: "assistant"` line carries `message.usage` with the same three
 *   counters, and the context held right now is their sum on the LATEST such
 *   line. One API message is written as one line per content block, each with
 *   identical usage, so the last line is the latest call. `message.model` is
 *   the bare id (`claude-opus-5-5`) with no window suffix — the same model runs
 *   at 200K or 1M — so the transcript names NO window.
 *
 * The prompt hook gets `transcript_path` but no usage and no window. So the
 * window is never guessed: from a model id, a display name or a default. A
 * window is known only when the statusline stated it; without one, only an
 * absolute token ceiling can be judged.
 */

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

const positiveInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null

/** Context held by one call: input + cache_creation + cache_read. Null when `usage` carries none of them. */
export function usageTokens(usage: unknown): number | null {
  if (!isObj(usage)) return null
  if (!('input_tokens' in usage || 'cache_creation_input_tokens' in usage || 'cache_read_input_tokens' in usage)) {
    return null
  }
  return count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens)
}

export interface StatuslineGauge {
  /** Tokens held, from `context_window.current_usage`; null before the first call. */
  tokens: number | null
  /** `context_window.context_window_size` — null when absent, never defaulted. */
  window: number | null
  /** `context_window.used_percentage` as stated. */
  usedPct: number | null
}

/** The gauge the statusline's stdin states. Null when it carries no `context_window`. */
export function statuslineGauge(hook: unknown): StatuslineGauge | null {
  if (!isObj(hook) || !isObj(hook.context_window)) return null
  const cw = hook.context_window
  const pct = cw.used_percentage
  return {
    tokens: usageTokens(cw.current_usage),
    window: positiveInt(cw.context_window_size),
    usedPct: typeof pct === 'number' && Number.isFinite(pct) ? pct : null,
  }
}

/** How far the stated percentage may sit from tokens / window, in points. */
export const GAUGE_AGREE_POINTS = 1

/**
 * Whether the statusline's own numbers agree: `used_percentage` against
 * tokens / window. Null when either side is missing — nothing to check.
 */
export function gaugeAgrees(gauge: StatuslineGauge): boolean | null {
  if (gauge.tokens === null || gauge.window === null || gauge.usedPct === null) return null
  return Math.abs((gauge.tokens / gauge.window) * 100 - gauge.usedPct) <= GAUGE_AGREE_POINTS
}

/** The tail a transcript read looks at: a call's line plus a large tool result after it. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024

/**
 * Context tokens of the latest main-chain assistant call in a Claude Code
 * transcript, read from its tail only (a transcript runs to tens of MB). Null
 * when the tail holds no such line or the file cannot be read — a hook treats
 * that as "unknown", never as zero.
 */
export function transcriptContextTokens(path: string, tailBytes = TRANSCRIPT_TAIL_BYTES): number | null {
  let text: string
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, tailBytes)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = text.split('\n')
  // A cut-off first line is torn, and parse failure skips it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || !line.includes('"assistant"')) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(entry) || entry.type !== 'assistant' || entry.isSidechain === true) continue
    const tokens = isObj(entry.message) ? usageTokens(entry.message.usage) : null
    if (tokens !== null) return tokens
  }
  return null
}
