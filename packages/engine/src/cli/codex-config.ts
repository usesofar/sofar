import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mcpRegistration } from '../mcp/register'

/**
 * sofar's MCP server in Codex's config.toml (agents-parity 2.2, D7).
 *
 * Codex reads no `.mcp.json`. It starts the servers named by
 * `[mcp_servers.<name>]` tables in config.toml: the project's
 * `.codex/config.toml` once the project is trusted, and the user's
 * (§Codex host). `command` and `args` are fields of 0.154.0's
 * `RawMcpServerConfig` (binary).
 *
 * There is no TOML dependency, so this module reads only a document's
 * STRUCTURE: where each table header and key/value pair sits, and the key
 * path it names. The scanner knows TOML's strings, arrays and inline tables
 * well enough never to take their contents for structure, and never
 * interprets a value. A file it cannot follow is unreadable, and init and
 * uninit never modify an unreadable file.
 */

export const CODEX_CONFIG = '.codex/config.toml'

/**
 * Pre-approves sofar's own tools (agents-parity 3.4). Without it, `codex exec`
 * under approval_policy=never refuses every sofar call ("MCP tool call requires
 * approval, but approval policy is never"). 0.158.0's parser takes
 * auto|prompt|writes|approve here; `approve` proven live under exec.
 */
export const CODEX_TOOLS_APPROVAL = 'default_tools_approval_mode = "approve"'

/** The table init appends: the same server `.mcp.json` registers, in TOML. */
export const CODEX_MCP_TABLE = ((): string => {
  const { command, args } = mcpRegistration().mcpServers.sofar
  return `[mcp_servers.sofar]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]\n${CODEX_TOOLS_APPROVAL}\n`
})()

/** The one user-level step when the project file cannot take the table: `codex mcp add` writes the user's config.toml (binary). */
export const CODEX_MCP_ADD = ((): string => {
  const { command, args } = mcpRegistration().mcpServers.sofar
  return `codex mcp add sofar -- ${[command, ...args].join(' ')}`
})()

/**
 * The user-level config.toml: `$CODEX_HOME/config.toml`, else
 * `~/.codex/config.toml`. The CODEX_HOME string is in the binary; that it
 * moves config.toml is unverified. `home` is the tests' override for the
 * whole machine, so CODEX_HOME is not read with it.
 */
export function codexUserConfigPath(home?: string): string {
  const codexHome = home === undefined ? process.env.CODEX_HOME : undefined
  return codexHome !== undefined && codexHome !== ''
    ? join(codexHome, 'config.toml')
    : join(home ?? homedir(), '.codex', 'config.toml')
}

// ---------------------------------------------------------------------------
// The structure scanner.
// ---------------------------------------------------------------------------

type KeyPath = readonly string[]

interface Header {
  path: KeyPath
  /** `[[…]]`, an array of tables. */
  array: boolean
  /** Offset of the header's line. */
  start: number
  /** Offset just past the header's line. */
  end: number
}

interface Pair {
  /** Full path: the enclosing header's, then the pair's own dotted key. */
  path: KeyPath
  header: Header | null
  /** Offset just past the pair's last line. */
  end: number
  /** The first-level keys of an inline-table value; empty for any other value. */
  inlineKeys: readonly string[]
}

interface Structure {
  headers: Header[]
  pairs: Pair[]
}

const ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

/** A bare scalar: number, boolean, date or time (one space allowed, for a date-time). */
const SCALAR = /^[0-9A-Za-z_+\-.:]+(?: [0-9A-Za-z_+\-.:]+)?$/

/** Headers and pairs in document order, or null when the text is not TOML the scanner can follow. */
function scan(text: string): Structure | null {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const unreadable = new Error('unreadable TOML')
  const fail = (): never => {
    throw unreadable
  }
  const at = (token: string): boolean => text.startsWith(token, i)

  const spaces = (): void => {
    while (text[i] === ' ' || text[i] === '\t') i++
  }
  const comment = (): void => {
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++
  }
  const newline = (): boolean => {
    if (text[i] === '\n') i += 1
    else if (at('\r\n')) i += 2
    else return false
    return true
  }
  /** What may follow a header or a pair on its line. */
  const lineEnd = (): void => {
    spaces()
    comment()
    if (!newline() && i < text.length) fail()
  }
  /** Space inside an array or inline table, where newlines and comments may sit. */
  const gap = (): void => {
    do {
      spaces()
      comment()
    } while (newline())
  }

  const basic = (): string => {
    let out = ''
    i++
    for (;;) {
      const c = text[i]
      if (c === undefined || c === '\n') return fail()
      if (c === '"') {
        i++
        return out
      }
      if (c !== '\\') {
        out += c
        i++
        continue
      }
      const e = text[i + 1] ?? ''
      if (e === 'u' || e === 'U') {
        const hex = text.slice(i + 2, i + (e === 'u' ? 6 : 10))
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== (e === 'u' ? 4 : 8)) fail()
        out += String.fromCodePoint(Number.parseInt(hex, 16))
        i += 2 + hex.length
        continue
      }
      out += ESCAPES[e] ?? fail()
      i += 2
    }
  }
  const literal = (): string => {
    const close = text.indexOf("'", i + 1)
    const body = close === -1 ? '\n' : text.slice(i + 1, close)
    if (body.includes('\n')) fail()
    i = close + 1
    return body
  }
  /** `"""…"""` or `'''…'''`; a closing run may carry up to two more quotes, which belong to the body. */
  const multiline = (quote: '"""' | "'''"): void => {
    i += 3
    for (;;) {
      if (i >= text.length) fail()
      if (quote === '"""' && text[i] === '\\') {
        i += 2
        continue
      }
      if (at(quote)) {
        i += 3
        for (let extra = 0; extra < 2 && text[i] === quote[0]; extra++) i++
        return
      }
      i++
    }
  }

  const key = (): string[] => {
    const path: string[] = []
    for (;;) {
      spaces()
      if (text[i] === '"') path.push(basic())
      else if (text[i] === "'") path.push(literal())
      else {
        const start = i
        while (i < text.length && /[A-Za-z0-9_-]/.test(text[i]!)) i++
        if (i === start) fail()
        path.push(text.slice(start, i))
      }
      spaces()
      if (text[i] !== '.') return path
      i++
    }
  }

  const value = (): string[] => {
    if (at('"""') || at("'''")) {
      multiline(text.slice(i, i + 3) as '"""' | "'''")
      return []
    }
    if (text[i] === '"') {
      basic()
      return []
    }
    if (text[i] === "'") {
      literal()
      return []
    }
    if (text[i] === '[') {
      i++
      for (;;) {
        gap()
        if (text[i] === ']') break
        value()
        gap()
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail()
      }
      i++
      return []
    }
    if (text[i] === '{') {
      const keys: string[] = []
      i++
      for (;;) {
        gap()
        if (text[i] === '}') break
        keys.push(key()[0]!)
        if (text[i] !== '=') fail()
        i++
        spaces()
        value()
        gap()
        if (text[i] === ',') i++
        else if (text[i] !== '}') fail()
      }
      i++
      return keys
    }
    const start = i
    while (i < text.length && !',]}#\r\n'.includes(text[i]!)) i++
    if (!SCALAR.test(text.slice(start, i).trimEnd())) fail()
    return []
  }

  const headers: Header[] = []
  const pairs: Pair[] = []
  let header: Header | null = null
  try {
    while (i < text.length) {
      const start = i
      spaces()
      comment()
      if (newline() || i >= text.length) continue
      if (text[i] === '[') {
        const array = at('[[')
        i += array ? 2 : 1
        const path = key()
        if (!at(array ? ']]' : ']')) fail()
        i += array ? 2 : 1
        lineEnd()
        header = { path, array, start, end: i }
        headers.push(header)
      } else {
        const path = key()
        if (text[i] !== '=') fail()
        i++
        spaces()
        const inlineKeys = value()
        lineEnd()
        pairs.push({ path: [...(header?.path ?? []), ...path], header, end: i, inlineKeys })
      }
    }
  } catch {
    return null
  }
  return { headers, pairs }
}

// ---------------------------------------------------------------------------
// sofar's server in a config.toml.
// ---------------------------------------------------------------------------

const SOFAR: KeyPath = ['mcp_servers', 'sofar']

function under(path: KeyPath, prefix: KeyPath): boolean {
  return prefix.every((part, index) => path[index] === part)
}

/**
 * - registered  a sofar server is defined, in any form — the user's, left as it is
 * - absent      no sofar server, and appending CODEX_MCP_TABLE keeps the file valid
 * - blocked     no sofar server, but `mcp_servers` is defined inline, by dotted
 *               keys or as an array, so a `[mcp_servers.sofar]` table would
 *               define it twice and invalidate the whole file
 * - unreadable  the scanner could not follow the file
 */
export type CodexMcpState = 'registered' | 'absent' | 'blocked' | 'unreadable'

export function codexMcpState(text: string): CodexMcpState {
  const doc = scan(text)
  if (doc === null) return 'unreadable'
  const registered =
    doc.headers.some((h) => under(h.path, SOFAR)) ||
    doc.pairs.some(
      (p) => under(p.path, SOFAR) || (p.path.length === 1 && p.path[0] === 'mcp_servers' && p.inlineKeys.includes('sofar')),
    )
  if (registered) return 'registered'
  const blocked =
    doc.headers.some((h) => h.array && h.path[0] === 'mcp_servers') ||
    doc.pairs.some((p) => p.path[0] === 'mcp_servers' && p.header?.path[0] !== 'mcp_servers')
  return blocked ? 'blocked' : 'absent'
}

/**
 * Does sofar's server set a tools approval mode, in any form? The scanner reads
 * no values, so a user's own `prompt` counts too — their choice wins (D7).
 * False when sofar is not registered or the file is unreadable.
 */
export function codexSofarToolsApprovalSet(text: string): boolean {
  const doc = scan(text)
  if (doc === null) return false
  const key: KeyPath = [...SOFAR, 'default_tools_approval_mode']
  return doc.pairs.some(
    (p) =>
      (p.path.length === key.length && under(p.path, key)) ||
      (p.path.length === SOFAR.length && under(p.path, SOFAR) && p.inlineKeys.includes('default_tools_approval_mode')),
  )
}

/** Is sofar registered in the config.toml at this path? A missing or unreadable file answers false. */
export function codexConfigRegistersSofar(path: string): boolean {
  try {
    return existsSync(path) && codexMcpState(readFileSync(path, 'utf8')) === 'registered'
  } catch {
    return false
  }
}

/** Append the table after the file's own bytes, a blank line between. Only for an `absent` file. */
export function withSofarServer(text: string): string {
  const separator = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${separator}${CODEX_MCP_TABLE}`
}

/**
 * Remove every `[mcp_servers.sofar]` table (and `[mcp_servers.sofar.*]`
 * sub-table): its header, its pairs and whatever lies between them, plus one
 * seam blank line before it. A comment after a table's last pair belongs to
 * what follows, so it stays. Null when the scanner cannot follow the file.
 * A sofar server defined in another form is not a table and is left.
 */
export function withoutSofarServer(text: string): string | null {
  const doc = scan(text)
  if (doc === null) return null
  let out = text
  for (const table of doc.headers.filter((h) => under(h.path, SOFAR)).reverse()) {
    const end = Math.max(table.end, ...doc.pairs.filter((p) => p.header === table).map((p) => p.end))
    let before = out.slice(0, table.start)
    if (before.endsWith('\n\n')) before = before.slice(0, -1)
    out = before + out.slice(end)
  }
  return out
}
