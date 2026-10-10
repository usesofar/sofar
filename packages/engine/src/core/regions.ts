/**
 * Edit regions (drive-lanes 3.1, D4, D33): the part of a file an edit
 * touches, NAMED so two lanes editing their own copies of the file can
 * compare. Each lane works in its own worktree, so line numbers drift between
 * the copies the moment either lane edits; the names of the sections and
 * symbols around an edit are what both copies still share.
 *
 * A region is the deepest markdown section or code symbol whose lines hold
 * the whole edit — its own lines when the edit stays clear of its children,
 * or with its children (`deep`) when the edit reaches into one. An edit no
 * section or symbol holds is the file's top level (`path: []`), and one that
 * spans top-level sections is the whole file (`path: []`, `deep`). A file
 * whose kind has no outline here, a Write, and an edit whose text cannot be
 * found all take the whole file.
 *
 * The code outline is a heuristic, deliberately: declaration patterns plus
 * indentation, never a parser, so the hook stays a file read and some regexes
 * (speed T2). It is read on formatted code, and where it misreads, the cost is
 * a coarser or finer region — a lease that steers when it need not, or a
 * conflict the merge queue still catches (2.4) — never a corrupted edit.
 */

/** One region of one file. */
export interface Region {
  /** Repo-relative, `/`-separated. */
  file: string
  /** Section or symbol names, outermost first; empty is the file's top level. */
  path: string[]
  /** The region holds its children too; `path: []` with `deep` is the whole file. */
  deep: boolean
}

/**
 * The leading import block of a code file, a region of its own that never
 * leases (D33): two lanes adding imports to one file is the commonest overlap
 * there is, git merges most of it, and steering a session off the import its
 * change needs would strand the change.
 */
export const IMPORTS = '(imports)'

/** The whole file. */
export function wholeFile(file: string): Region {
  return { file, path: [], deep: true }
}

/** Whether a region may be leased at all. */
export function leasable(region: Region): boolean {
  return region.path[0] !== IMPORTS
}

/**
 * Two regions overlap when they are in the same file and either names the
 * same section or symbol, or one is an ancestor of the other that holds its
 * children. The whole file overlaps every region of the file; the top level's
 * own lines overlap no section's.
 */
export function overlaps(a: Region, b: Region): boolean {
  if (a.file !== b.file) return false
  const [short, long] = a.path.length <= b.path.length ? [a, b] : [b, a]
  if (!short.path.every((name, i) => name === long.path[i])) return false
  return short.path.length === long.path.length || short.deep
}

/** Stable identity for de-duplication. */
export function regionKey(region: Region): string {
  return JSON.stringify([region.file, region.path, region.deep])
}

/** How a region reads in a hook's context: `file › Section › Sub`. */
export function describeRegion(region: Region): string {
  if (region.path.length > 0) return `${region.file} › ${region.path.join(' › ')}${region.deep && region.path.length > 0 ? ' (and what it holds)' : ''}`
  return region.deep ? `${region.file} (whole file)` : `${region.file} (top level)`
}

/** What an edit tool call does to a file, as far as regions care. */
export type EditCall =
  /** Write, NotebookEdit, or anything not a string replacement: the whole file. */
  | { kind: 'whole' }
  /** Edit (one) or MultiEdit (several, applied in order). */
  | { kind: 'edits'; edits: { old: string; new: string; all: boolean }[] }

/**
 * The regions one call touches in `file`, whose text before the call is
 * `content` (null when the file cannot be read: a new file, or one gone).
 * MultiEdit's edits are applied in order, since a later one may only match
 * what an earlier one wrote.
 */
export function editRegions(file: string, content: string | null, call: EditCall): Region[] {
  const kind = outlineKind(file)
  if (call.kind === 'whole' || content === null || kind === null || call.edits.length === 0) return [wholeFile(file)]
  const out = new Map<string, Region>()
  let text = content
  for (const edit of call.edits) {
    if (edit.old.length === 0) return [wholeFile(file)]
    const offsets: number[] = []
    for (let at = text.indexOf(edit.old); at !== -1; at = edit.all ? text.indexOf(edit.old, at + edit.old.length) : -1) offsets.push(at)
    if (offsets.length === 0) return [wholeFile(file)]
    const lines = text.split('\n')
    const nodes = kind === 'markdown' ? markdownOutline(lines) : codeOutline(lines, kind)
    for (const at of offsets) {
      const first = lineAt(text, at)
      const last = lineAt(text, at + edit.old.length - (edit.old.endsWith('\n') ? 1 : 0))
      const region = { file, ...regionIn(nodes, first, Math.max(first, last)) }
      out.set(regionKey(region), region)
    }
    text = edit.all ? text.split(edit.old).join(edit.new) : `${text.slice(0, offsets[0]!)}${edit.new}${text.slice(offsets[0]! + edit.old.length)}`
  }
  return [...out.values()]
}

/** One section or symbol: its name, its lines `[start, end)`, and what it holds. */
export interface OutlineNode {
  name: string
  start: number
  end: number
  children: OutlineNode[]
}

type OutlineKind = 'markdown' | 'ts' | 'rust' | 'go' | 'python'

const KINDS: ReadonlyArray<[RegExp, OutlineKind]> = [
  [/\.(md|mdx|markdown)$/i, 'markdown'],
  [/\.([cm]?[jt]sx?)$/i, 'ts'],
  [/\.rs$/i, 'rust'],
  [/\.go$/i, 'go'],
  [/\.pyi?$/i, 'python'],
]

function outlineKind(file: string): OutlineKind | null {
  for (const [pattern, kind] of KINDS) if (pattern.test(file)) return kind
  return null
}

/** Zero-based line of a character offset. */
function lineAt(text: string, offset: number): number {
  let line = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line += 1
  return line
}

/** The deepest node holding lines `[first, last]`, and whether the span reaches into its children. */
function regionIn(nodes: OutlineNode[], first: number, last: number): { path: string[]; deep: boolean } {
  const path: string[] = []
  let level = nodes
  for (;;) {
    const inside = level.find((n) => n.start <= first && last < n.end)
    if (inside === undefined) break
    path.push(inside.name)
    level = inside.children
  }
  return { path, deep: level.some((n) => n.start <= last && first < n.end) }
}

/** Collapse whitespace and bound a name: it travels in every lease line. */
function cleanName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

// ---------------------------------------------------------------------------
// Markdown: ATX headings outside fenced code, and SPEC's `**Bold label**`
// paragraphs beneath them (CLAUDE.md, the § rule), as the deepest level.
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BOLD_LABEL = /^\*\*([^*]+?)\*\*/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
/** A bold label nests under any heading. */
const LABEL_LEVEL = 7

export function markdownOutline(lines: readonly string[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: { level: number; node: OutlineNode }[] = []
  let fence: string | null = null
  const close = (level: number, at: number): void => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop()!.node.end = at
  }
  lines.forEach((line, i) => {
    const fenced = FENCE.exec(line)
    if (fenced !== null) {
      const mark = fenced[1]!
      if (fence === null) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      return
    }
    if (fence !== null) return
    const heading = HEADING.exec(line)
    const label = heading === null ? BOLD_LABEL.exec(line) : null
    const level = heading !== null ? heading[1]!.length : label !== null ? LABEL_LEVEL : 0
    if (level === 0) return
    const name = cleanName(heading !== null ? heading[2]! : label![1]!.replace(/[.:]\s*$/, ''))
    if (name.length === 0) return
    close(level, i)
    const node: OutlineNode = { name, start: i, end: lines.length, children: [] }
    ;(stack.length > 0 ? stack[stack.length - 1]!.node.children : roots).push(node)
    stack.push({ level, node })
  })
  close(0, lines.length)
  return roots
}

// ---------------------------------------------------------------------------
// Code: declaration lines, each running on through every line indented
// deeper, and every closing line (`}`, `)`, `]`) at its own indentation.
// ---------------------------------------------------------------------------

type Decl = (trimmed: string, inClass: boolean) => { name: string; isClass: boolean } | null

const TEST_BLOCK = /^(describe|it|test|suite|bench)(?:\.\w+(?:\([^)]*\))?)*\(\s*(['"`])((?:(?!\2).)*)\2/
const TS_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const\s+enum|function\*?|class|interface|type|enum|namespace|module|const|let|var)\s+([A-Za-z_$][\w$]*)/
const TS_MEMBER = /^(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\s+)*\*?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:\(|=)/
const NOT_MEMBERS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'with', 'await', 'yield', 'throw', 'new', 'typeof', 'super', 'this'])
const RUST_FN = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+([A-Za-z_]\w*)/
const RUST_ITEM = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union|mod|type|static|const)\s+(?:mut\s+)?([A-Za-z_]\w*)/
const RUST_IMPL = /^(?:unsafe\s+)?impl\b(?:\s*<[^>]*>)?\s+(.+?)\s*(?:\bwhere\b.*)?\{?\s*$/
const RUST_MACRO = /^macro_rules!\s*([A-Za-z_]\w*)/
const GO_DECL = /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Za-z_]\w*)/
const PY_DECL = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/

const DECLS: Record<Exclude<OutlineKind, 'markdown'>, Decl> = {
  ts: (t, inClass) => {
    const test = TEST_BLOCK.exec(t)
    if (test !== null) return { name: `${test[1]} ${test[3]}`, isClass: false }
    const decl = TS_DECL.exec(t)
    if (decl !== null) return { name: decl[2]!, isClass: decl[1] === 'class' }
    if (!inClass) return null
    const member = TS_MEMBER.exec(t)
    return member !== null && !NOT_MEMBERS.has(member[1]!) ? { name: member[1]!, isClass: false } : null
  },
  rust: (t) => {
    const fn = RUST_FN.exec(t)
    if (fn !== null) return { name: fn[1]!, isClass: false }
    const item = RUST_ITEM.exec(t)
    if (item !== null) return { name: item[2]!, isClass: false }
    const impl = RUST_IMPL.exec(t)
    if (impl !== null) return { name: `impl ${impl[1]!}`, isClass: false }
    const macro = RUST_MACRO.exec(t)
    return macro !== null ? { name: macro[1]!, isClass: false } : null
  },
  go: (t) => {
    const decl = GO_DECL.exec(t)
    return decl !== null ? { name: decl[1]!, isClass: false } : null
  },
  python: (t) => {
    const decl = PY_DECL.exec(t)
    return decl !== null ? { name: decl[2]!, isClass: decl[1] === 'class' } : null
  },
}

/** A leading-block line: an import, a module line, a comment, a directive. */
const LEAD = /^(?:import\b|export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\b|use\s|extern\s+crate\b|(?:pub\s+)?mod\s+\w+\s*;|from\s+\S+\s+import\b|package\s|require\(|['"]use strict['"]|\/\/|\/\*|\*|#!|#\[|#(?!\[)|\}\s*from\b)/
/** A comment or attribute line that belongs to the declaration below it. */
const ATTACHED = /^(?:\/\/|\/\*|\*|#\[|#(?![[!])|@)/
/** Closes what its indentation opened. */
const CLOSER = /^[}\])]/
/** Most levels of nesting an outline descends. */
const MAX_DEPTH = 4

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

export function codeOutline(lines: readonly string[], kind: Exclude<OutlineKind, 'markdown'>): OutlineNode[] {
  const decl = DECLS[kind]
  const nodes: OutlineNode[] = []
  const imports = leadingBlock(lines)
  if (imports > 0) nodes.push({ name: IMPORTS, start: 0, end: imports, children: [] })
  nodes.push(...declsIn(lines, decl, imports, lines.length, -1, false, 0))
  return nodes
}

/** Lines `[0, n)` that are the file's leading imports, comments and blanks; a multi-line import's inner lines included. */
function leadingBlock(lines: readonly string[]): number {
  let end = 0
  let open = false
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i]!.trim()
    if (t.length === 0) continue
    if (open || LEAD.test(t) || (indentOf(lines[i]!) > 0 && end === i)) {
      open = /[{(]\s*$/.test(t) ? true : open && !/^[})]/.test(t)
      end = i + 1
      continue
    }
    break
  }
  // Trailing comments belong to whatever they sit above, not to the imports.
  while (end > 0 && (lines[end - 1]!.trim().length === 0 || ATTACHED.test(lines[end - 1]!.trim()))) end -= 1
  return end
}

/**
 * Declarations in lines `[from, to)` indented deeper than `parentIndent`. A
 * nested one counts only when it spans more than its own line: a one-line
 * local is part of what holds it.
 */
function declsIn(
  lines: readonly string[],
  decl: Decl,
  from: number,
  to: number,
  parentIndent: number,
  inClass: boolean,
  depth: number,
): OutlineNode[] {
  const out: OutlineNode[] = []
  for (let i = from; i < to; i += 1) {
    const line = lines[i]!
    const t = line.trim()
    if (t.length === 0) continue
    const indent = indentOf(line)
    if (indent <= parentIndent) continue
    if (depth === 0 && indent > 0) continue
    const found = decl(t, inClass)
    if (found === null) continue
    let end = i + 1
    for (let j = i + 1; j < to; j += 1) {
      const next = lines[j]!
      if (next.trim().length === 0) continue
      const at = indentOf(next)
      if (at > indent || (at === indent && CLOSER.test(next.trimStart()))) {
        end = j + 1
        continue
      }
      break
    }
    if (depth > 0 && end - i < 2) continue
    let start = i
    while (start > from) {
      const above = lines[start - 1]!
      const a = above.trim()
      const at = indentOf(above)
      if (a.length === 0 || !ATTACHED.test(a) || at < indent || at > indent + 1) break
      start -= 1
    }
    const children = depth + 1 < MAX_DEPTH ? declsIn(lines, decl, i + 1, end, indent, found.isClass, depth + 1) : []
    out.push({ name: cleanName(found.name), start, end, children })
    i = end - 1
  }
  return out
}
