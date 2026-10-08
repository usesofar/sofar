import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InitiativeState } from './fold'
import { headSha } from './git'
import { lexicalCounts } from './lexicon'
import { focusTask } from '../projections/templates/status'

/**
 * The work map (r4-fixes B1, re-scoped by r4-fixes D16): the entry points of
 * the files this record touched, as `name:line`, told once per session on its
 * first prompt.
 *
 * Round 4's Claude sessions spent 38% of their work calls on locate-greps,
 * mostly hunting a function or an error code inside a file the record already
 * knew about. A file map cannot answer those (file discovery was 8.6%); a
 * symbol map can. The replay (handoff-bench r4-research
 * scripts/b1_symbol_replay.py) named a target for 41% of pre-edit
 * locate-greps at 1,000 chars.
 *
 * The scan reads the worktree, not git, so line numbers are what the agent
 * would see now; the header names HEAD so a reader can tell how fresh it is.
 * No model, no parser: a hand-written line scanner that `workmap.rs` mirrors
 * exactly. Files the record touched that no longer exist are dropped.
 */

/** Env switch: `SOFAR_WORKMAP=off` (also `0`, `false`) is the ablation arm. */
export const WORKMAP_ENV = 'SOFAR_WORKMAP'
export function workmapEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = (env[WORKMAP_ENV] ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** The block's budget in UTF-16 units, header included — the replay's knee (r4-fixes D16). */
export const WORKMAP_BUDGET = 1_000
/** Files scanned, at most: the focus task's first, then the newest touched. */
export const WORKMAP_FILES = 32
/** A file larger than this is skipped whole (generated or vendored, not an entry point). */
export const WORKMAP_FILE_BYTES = 400_000
/** Bytes read across all files, at most — the hot-path bound. */
export const WORKMAP_TOTAL_BYTES = 2_000_000
/** Prompt text the cue terms are taken from (recall's RECALL_PROMPT_CHARS). */
export const WORKMAP_PROMPT_CHARS = 2_000
/** The told-set key: the map is told once per session (until a compaction clears the set). */
export const WORKMAP_TOLD_KEY = 'workmap prompt'

type Lang = 'js' | 'py' | 'go' | 'rs'

const LANG_BY_EXT: Readonly<Record<string, Lang>> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', go: 'go', rs: 'rs',
}

/** One entry point: its name, 1-based line, and whether it is a definition or an error-code literal. */
export interface WorkSymbol {
  name: string
  line: number
  kind: 'def' | 'code'
}

function langOf(path: string): Lang | null {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash + 1) return null
  return LANG_BY_EXT[path.slice(dot + 1)] ?? null
}

const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z'
const isLower = (c: string): boolean => c >= 'a' && c <= 'z'
const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isIdentStart = (c: string): boolean => isUpper(c) || isLower(c) || c === '_' || c === '$'
const isIdent = (c: string): boolean => isIdentStart(c) || isDigit(c)
const isAlnum = (c: string): boolean => isUpper(c) || isLower(c) || isDigit(c)
const isSpace = (c: string): boolean => c === ' ' || c === '\t'

/** The identifier at `i` (ASCII `[A-Za-z_$][A-Za-z0-9_$]*`), or '' if none starts there. */
function identAt(s: string, i: number): string {
  if (i >= s.length || !isIdentStart(s[i]!)) return ''
  let j = i + 1
  while (j < s.length && isIdent(s[j]!)) j++
  return s.slice(i, j)
}

/** Skips spaces and tabs from `i`. */
function skipSpace(s: string, i: number): number {
  while (i < s.length && isSpace(s[i]!)) i++
  return i
}

/** `s` starts with `word` at `i`, followed by at least one space or tab; returns the index after them, or -1. */
function word(s: string, i: number, w: string): number {
  if (!s.startsWith(w, i)) return -1
  const j = i + w.length
  if (j >= s.length || !isSpace(s[j]!)) return -1
  return skipSpace(s, j)
}

/** Takes the first matching optional word, if any. */
function optional(s: string, i: number, words: readonly string[]): number {
  for (const w of words) {
    const j = word(s, i, w)
    if (j >= 0) return j
  }
  return i
}

const JS_DECL = ['function*', 'function', 'const', 'let', 'var', 'class', 'interface', 'type', 'enum']
const JS_MODIFIERS = ['public', 'private', 'protected', 'static', 'async', 'override']
const JS_NOT_METHOD = new Set(['for', 'while', 'switch', 'catch', 'return', 'else', 'super', 'await', 'typeof', 'function'])

/** `export [default] [declare] [abstract] [async] <decl> <name>`, or `[async] function <name>(`. */
function jsTopDef(t: string): string {
  let i = word(t, 0, 'export')
  if (i >= 0) {
    i = optional(t, i, ['default'])
    i = optional(t, i, ['declare'])
    i = optional(t, i, ['abstract'])
    i = optional(t, i, ['async'])
    for (const d of JS_DECL) {
      // `function* name` and `function *name` both declare a generator.
      if (d === 'function' && t.startsWith('function*', i)) continue
      const j = word(t, i, d)
      if (j >= 0) return identAt(t, d === 'function' && t[j] === '*' ? j + 1 : j)
    }
    return ''
  }
  i = optional(t, 0, ['async'])
  const j = word(t, i, 'function')
  if (j < 0) return ''
  const name = identAt(t, j)
  return name !== '' && t[skipSpace(t, j + name.length)] === '(' ? name : ''
}

/** A lowercase method name: `[a-z][A-Za-z0-9]{2,}`, or '' when `i` starts none. */
function methodName(t: string, i: number): string {
  if (i >= t.length || !isLower(t[i]!)) return ''
  let j = i + 1
  while (j < t.length && isAlnum(t[j]!)) j++
  return j - i >= 3 ? t.slice(i, j) : ''
}

/**
 * A class or object method two to four columns in: `[modifiers] name(params) [: type] {`
 * ending the line, or `name: [async] (`. Params hold no `)`, the type no `{` or `=`.
 */
function jsMethod(t: string): string {
  let i = 0
  for (let k = 0; k < JS_MODIFIERS.length; ) {
    const j = word(t, i, JS_MODIFIERS[k]!)
    if (j >= 0) {
      i = j
      k = 0
      continue
    }
    k++
  }
  const name = methodName(t, i)
  if (name === '' || JS_NOT_METHOD.has(name)) return ''
  let j = skipSpace(t, i + name.length)
  if (t[j] === ':' && i === 0) {
    j = skipSpace(t, j + 1)
    j = optional(t, j, ['async'])
    return t[j] === '(' ? name : ''
  }
  if (t[j] !== '(') return ''
  const close = t.indexOf(')', j + 1)
  if (close < 0) return ''
  const tail = t.slice(close + 1).trimEnd()
  if (!tail.endsWith('{')) return ''
  const mid = tail.slice(0, -1).trim()
  if (mid === '') return name
  return mid.startsWith(':') && !mid.includes('{') && !mid.includes('=') ? name : ''
}

function pyDef(t: string): string {
  const i = optional(t, 0, ['async'])
  const j = word(t, i, 'def')
  if (j >= 0) return identAt(t, j)
  const k = i === 0 ? word(t, 0, 'class') : -1
  return k >= 0 ? identAt(t, k) : ''
}

function goDef(t: string): string {
  let i = word(t, 0, 'func')
  if (i >= 0) {
    if (t[i] === '(') {
      const close = t.indexOf(')', i)
      if (close < 0) return ''
      i = skipSpace(t, close + 1)
    }
    return identAt(t, i)
  }
  i = word(t, 0, 'type')
  return i >= 0 ? identAt(t, i) : ''
}

const RS_VIS = ['pub(crate)', 'pub(super)', 'pub']
const RS_QUAL = ['const', 'async', 'unsafe']
const RS_ITEM = ['fn', 'struct', 'enum', 'trait', 'const', 'static', 'type', 'mod']

function rsDef(t: string): string {
  let i = optional(t, 0, RS_VIS)
  // `const fn` qualifies a function; a bare `const NAME` is an item of its own.
  const q = optional(t, i, RS_QUAL)
  if (q !== i && word(t, q, 'fn') >= 0) i = q
  for (const item of RS_ITEM) {
    const j = word(t, i, item)
    if (j >= 0) return identAt(t, j)
  }
  return ''
}

/** The definition a line opens, or '' — by language, with the indent each form allows. */
function defOf(lang: Lang, line: string): string {
  let indent = 0
  while (indent < line.length && isSpace(line[indent]!)) indent++
  // Every form opens on a lowercase keyword or name: a cheap reject for the
  // braces, comments and calls that make up most lines.
  if (indent >= line.length || !isLower(line[indent]!)) return ''
  const t = line.slice(indent)
  switch (lang) {
    case 'js': {
      const top = jsTopDef(t)
      if (top !== '') return top
      return indent >= 2 && indent <= 4 ? jsMethod(t) : ''
    }
    case 'py':
      return indent === 0 || indent === 4 ? pyDef(t) : ''
    case 'go':
      return indent === 0 ? goDef(t) : ''
    case 'rs':
      return indent === 0 || indent === 4 ? rsDef(t) : ''
  }
}

/**
 * Quoted error codes on a line: `'X_YZ'` or `"X_YZ"` — an uppercase letter,
 * then `[A-Z0-9_]`, with an underscore that has at least two characters after
 * it. Scanned left to right, never overlapping.
 */
function codesOf(line: string): string[] {
  const out: string[] = []
  const sq = line.indexOf("'")
  const dq = line.indexOf('"')
  if (sq < 0 && dq < 0) return out
  let i = sq < 0 ? dq : dq < 0 ? sq : Math.min(sq, dq)
  while (i < line.length) {
    const c = line[i]!
    if (c !== "'" && c !== '"') {
      i++
      continue
    }
    let j = i + 1
    while (j < line.length && (isUpper(line[j]!) || isDigit(line[j]!) || line[j] === '_')) j++
    const run = line.slice(i + 1, j)
    const closes = j < line.length && (line[j] === "'" || line[j] === '"')
    const under = run.indexOf('_')
    if (closes && run.length > 0 && isUpper(run[0]!) && under >= 1 && run.length - under - 1 >= 2) {
      out.push(run)
      i = j + 1
    } else {
      i++
    }
  }
  return out
}

/** Every entry point of one file's text, first occurrence of each name, in line order. */
export function symbolsOf(path: string, text: string): WorkSymbol[] {
  const lang = langOf(path)
  if (lang === null) return []
  const out: WorkSymbol[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!
    const def = defOf(lang, line)
    if (def !== '' && !seen.has(def)) {
      seen.add(def)
      out.push({ name: def, line: n + 1, kind: 'def' })
    }
    for (const code of codesOf(line)) {
      if (seen.has(code)) continue
      seen.add(code)
      out.push({ name: code, line: n + 1, kind: 'code' })
    }
  }
  return out
}

/** `reserveStock` → `reserve stock`; `MAX_QTY` → `max qty`; `XMLParser` → `xml parser`. */
export function identWords(name: string): string {
  const words: string[] = []
  let cur = ''
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!
    if (!isAlnum(c)) {
      if (cur !== '') words.push(cur)
      cur = ''
      continue
    }
    const prev = i > 0 ? name[i - 1]! : ''
    const next = i + 1 < name.length ? name[i + 1]! : ''
    const boundary =
      cur !== '' &&
      ((isUpper(c) && (isLower(prev) || isDigit(prev))) ||
        (isUpper(c) && isUpper(prev) && isLower(next)) ||
        (isDigit(c) && !isDigit(prev)) ||
        (!isDigit(c) && isDigit(prev)))
    if (boundary) {
      words.push(cur)
      cur = ''
    }
    cur += c
  }
  if (cur !== '') words.push(cur)
  return words.join(' ').toLowerCase()
}

/**
 * A recorded path as a repo-relative one, or null. Hooks record what the host
 * sent — absolute, and from whichever worktree the session ran in — so a path
 * outside this checkout is matched by its longest suffix of two or more
 * components that is a file here.
 */
export function repoPath(rootDir: string, recorded: string): string | null {
  let rel: string | null = null
  if (!recorded.startsWith('/')) {
    rel = recorded.startsWith('./') ? recorded.slice(2) : recorded
  } else if (recorded.startsWith(rootDir + '/')) {
    rel = recorded.slice(rootDir.length + 1)
  } else {
    const parts = recorded.split('/').filter((p) => p !== '')
    for (let i = 1; i + 2 <= parts.length; i++) {
      const cand = parts.slice(i).join('/')
      if (isFile(join(rootDir, cand))) {
        rel = cand
        break
      }
    }
  }
  if (rel === null || rel === '' || rel.startsWith('../')) return null
  if (rel.startsWith('.sofar/') || rel.startsWith('.git/') || rel.includes('node_modules/')) return null
  return rel
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A file's text and its size in bytes when it exists and fits; null otherwise. */
function readBounded(path: string, limit: number): { text: string; bytes: number } | null {
  let fd: number | null = null
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > limit) return null
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got)
      if (n <= 0) break
      got += n
    }
    return { text: buf.subarray(0, got).toString('utf8'), bytes: got }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The files to scan, best first: the focus task's (newest first), then every other touched file, newest first. */
export function workmapFiles(rootDir: string, state: InitiativeState): string[] {
  const focus = focusTask(state)?.task.id
  const ordered = [...(focus !== undefined ? state.task_files[focus] ?? [] : []), ...[...state.files_touched].reverse()]
  const out: string[] = []
  const seen = new Set<string>()
  for (const recorded of ordered) {
    if (out.length >= WORKMAP_FILES) break
    const rel = repoPath(rootDir, recorded)
    if (rel === null || seen.has(rel) || langOf(rel) === null) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

const isTestPath = (p: string): boolean =>
  p.startsWith('test/') || p.startsWith('tests/') || p.includes('/test/') || p.includes('/tests/') || p.includes('.test.') || p.includes('.spec.')

function stems(text: string): Set<string> {
  return new Set(Object.keys(lexicalCounts(text)))
}

interface Ranked {
  file: string
  fileRank: number
  test: boolean
  sym: WorkSymbol
  score: number
}

/**
 * The block, or null when nothing scans. Ranking: a symbol whose words the
 * prompt uses first (3 per stem, 4 more for the name verbatim), then the focus
 * task's title (2 per stem); ties go to source before tests, then the focus
 * task's and newer files, then line order. Each name is listed once.
 */
export function workmapBlock(rootDir: string, state: InitiativeState, prompt: string, budget = WORKMAP_BUDGET): string | null {
  const files = workmapFiles(rootDir, state)
  if (files.length === 0) return null
  const cue = prompt.slice(0, WORKMAP_PROMPT_CHARS)
  const cueStems = stems(cue)
  const focus = focusTask(state)?.task.title ?? ''
  const focusStems = stems(focus)
  const ranked: Ranked[] = []
  let total = 0
  files.forEach((file, fileRank) => {
    if (total >= WORKMAP_TOTAL_BYTES) return
    const read = readBounded(join(rootDir, file), Math.min(WORKMAP_FILE_BYTES, WORKMAP_TOTAL_BYTES - total))
    if (read === null) return
    total += read.bytes
    const text = read.text
    const test = isTestPath(file)
    for (const sym of symbolsOf(file, text)) {
      let score = 0
      for (const s of stems(identWords(sym.name))) {
        if (cueStems.has(s)) score += 3
        if (focusStems.has(s)) score += 2
      }
      if (sym.name.length >= 4 && cue.includes(sym.name)) score += 4
      ranked.push({ file, fileRank, test, sym, score })
    }
  })
  if (ranked.length === 0) return null
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.test) - Number(b.test) ||
      a.fileRank - b.fileRank ||
      a.sym.line - b.sym.line,
  )
  const sha = headSha(rootDir)
  const head = sha !== null ? `Entry points (worktree at ${sha.slice(0, 7)}; name:line):` : 'Entry points (name:line):'
  let used = head.length
  const chosen = new Set<string>()
  const byFile = new Map<string, string[]>()
  for (const r of ranked) {
    if (chosen.has(r.sym.name)) continue
    const tok = ` ${r.sym.name}:${r.sym.line}`
    const cost = tok.length + (byFile.has(r.file) ? 0 : r.file.length + 2)
    if (used + cost > budget) continue
    used += cost
    chosen.add(r.sym.name)
    const toks = byFile.get(r.file)
    if (toks === undefined) byFile.set(r.file, [tok])
    else toks.push(tok)
  }
  if (byFile.size === 0) return null
  return [head, ...[...byFile].map(([file, toks]) => `${file}:${toks.join('')}`)].join('\n')
}

