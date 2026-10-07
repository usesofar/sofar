import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { version as SOFAR_VERSION } from '../../package.json'
import { commonGitDir } from '../core/git'
import type { StateEnv } from '../core/state-dir'
import { AGENT_LABELS, AGENTS, type AgentId } from './agents'
import { CODEX_CONFIG, codexMcpState, withoutSofarDirect, withoutSofarServer } from './codex-config'
import {
  CODEX_SHIM_DIR,
  CODEX_SHIMS,
  GITATTRIBUTES_LINES,
  GIT_HOOKS,
  isSofarStatusline,
  PROTOCOL_END,
  PROTOCOL_START,
  SHIM_HOMES,
  SHIMS,
  wiredAgents,
  SHIPPED_WRITE_SKILLS,
  WRITE_SKILL,
  WRITE_SKILL_NAME,
  WRITE_SKILL_PATHS,
} from './init'
import {
  appendWiringEntry,
  consentOf,
  journalPath,
  readWiringJournalLines,
  sha256Hex,
  type WiringFile,
  writtenFiles,
} from './wiring-journal'
import { hostShapedJSON } from './formatters'
import { fail, ok, type CmdResult } from './shared'
import { type Caps, createStyle, stderrCaps, stdoutCaps, symbolsFor } from './ui'

/**
 * `sofar uninit [--purge]` (task 8.1, SPEC §CLI, BD45) — the exact inverse
 * of `sofar init`, surgical: remove ONLY what init installed and preserve
 * every byte of user content around it.
 *
 *   - the hook shims in .claude/hooks/, or in .cursor/hooks/sofar/ for a repo
 *     set up without Claude Code (r1-fixes 7.1, D36) — other files there are
 *     sacred; directories go only when THIS run emptied them
 *   - settings.json hook entries whose command points at one of our five
 *     shims (matched on the shim path substring); emptied matcher groups,
 *     event arrays, and the hooks key itself are pruned
 *   - the settings.json statusLine entry, ONLY when it is the one
 *     `init --statusline` installs (matched on type + command, tolerating a
 *     retuned refreshInterval) — a customized statusLine is user config,
 *     kept (init-statusline D1, statusline-refresh D1)
 *   - .mcp.json's mcpServers.sofar (other servers/keys untouched)
 *   - Cursor's copies (r1-fixes 6.2/6.6): .cursor/hooks.json entries running
 *     one of our shims, and .cursor/mcp.json's mcpServers.sofar
 *   - Codex's (agents-parity 2.1, D5): the shims in .codex/hooks/sofar/ and
 *     the .codex/hooks.json entries running them, and (2.2, D7) the
 *     [mcp_servers.sofar] table in .codex/config.toml
 *   - the marker-delimited protocol blocks in CLAUDE.md / AGENTS.md, plus
 *     exactly one adjacent blank-line seam so pre-init spacing is restored
 *
 * .sofar/ (the record) is KEPT by default — uninstalling the wiring must
 * never destroy the memory; a notice points at --purge. With --purge the
 * record is deleted, and ONLY --purge may also delete a managed file THIS
 * run emptied entirely (CLAUDE.md/AGENTS.md left zero-byte, settings.json/
 * .mcp.json left {}): that is what makes a fresh repo's init → uninit
 * --purge round-trip byte-clean (BD45). Without --purge those files stay,
 * even empty — the user may have created them.
 *
 * Unparseable user JSON aborts with exit 1 (init's caution, mirrored):
 * a file we cannot parse might still carry our entries, and guessing risks
 * user config.
 *
 * `--agent <id>` (r4-fixes A11) reverses one agent's wiring and only what this
 * clone's wiring journal says sofar wrote for it: a file the journal never
 * names is left (and listed), a shim whose bytes changed since is left, an
 * emptied file is deleted only when a journaled write created it, and the
 * shared files — .sofar/, .gitattributes, the git hooks, AGENTS.md while
 * the other agent reading it stays, a shim dir another agent still runs — are
 * never touched. Every uninit that changes something is journaled, and it
 * withdraws its agents' choice from the consent set.
 */

export interface UninitOptions {
  /** Also delete .sofar/ (the record) and files this run emptied. */
  purge?: boolean
  /** Reverse only this agent's journaled writes (r4-fixes A11). */
  agent?: AgentId
  /** Who is running this uninit, for the wiring journal (r4-fixes A11); the CLI always passes it. */
  journal?: UninitJournalContext
}

export interface UninitJournalContext {
  argv: readonly string[]
  cwd: string
  tty: boolean
  /** State-dir environment override — tests only. */
  env?: StateEnv
  /** Clock override — tests only. */
  now?: () => string
}

/** The files this uninit run changed, for the wiring journal (A11); null outside a run. */
let runChanges: WiringFile[] | null = null

function put(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
  runChanges?.push({ path, op: 'write', sha256: sha256Hex(content) })
}

function drop(path: string): void {
  unlinkSync(path)
  runChanges?.push({ path, op: 'remove' })
}

class UninitAbort extends Error {}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readJSONObject(path: string, label: string): Obj {
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new UninitAbort(
      `${label} is not valid JSON — refusing to modify it. Fix or remove it, then re-run sofar uninit. (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (!isObj(decoded)) {
    throw new UninitAbort(`${label} must contain a JSON object — refusing to modify it.`)
  }
  return decoded
}

/** init's stable JSON form (the host formatter's shape, plain 2-space without one) — rewriting with the same form preserves bytes. */
function stableJSON(rootDir: string, rel: string, value: unknown): string {
  return hostShapedJSON(rootDir, rel, value)
}

/** A hook command is ours iff it points at one of the shim paths, in any home. */
const SHIM_PATH_SUBSTRINGS = [
  ...Object.values(SHIM_HOMES).flatMap(({ dir }) => SHIMS.map((shim) => `${dir}/${shim.file}`)),
  ...CODEX_SHIMS.map((shim) => `${CODEX_SHIM_DIR}/${shim.file}`),
]

function isShimCommand(hook: unknown): boolean {
  return (
    isObj(hook) &&
    typeof hook.command === 'string' &&
    SHIM_PATH_SUBSTRINGS.some((path) => (hook.command as string).includes(path))
  )
}

// ---------------------------------------------------------------------------
// Steps — each pushes "removed …"/"updated …" report lines (changes only).
// ---------------------------------------------------------------------------

function removeShims(rootDir: string, dir: string, report: string[], shims = SHIMS): number {
  let removed = 0
  for (const shim of shims) {
    const path = join(rootDir, dir, shim.file)
    if (!existsSync(path)) continue
    drop(path)
    report.push(`removed ${dir}/${shim.file}`)
    removed++
  }
  return removed
}

/**
 * Remove the prepare-commit-msg git hook — but ONLY if it is still ours.
 *
 * Symmetry with installGitHook: init refuses to clobber a hook it did not
 * write, so uninit must refuse to delete one. A hand-written hook that merely
 * calls `sofar commit-trailer` is the user's file, and `.git/hooks` has no
 * version control to recover it from.
 */
function removeGitHook(rootDir: string, report: string[]): void {
  const dir = commonGitDir(rootDir) // where installGitHook put it

  if (dir === null) return
  // Every hook init installs (GIT_HOOKS: prepare-commit-msg, and pre-commit
  // since memory-lead 2.3), each only while its marker says it is ours.
  for (const hook of GIT_HOOKS) {
    const path = join(dir, 'hooks', hook.name)
    if (!existsSync(path)) continue
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (!content.includes(hook.marker)) continue // yours — left alone
    drop(path)
    report.push(`removed .git/hooks/${hook.name}`)
  }
}

/**
 * Strip our commands from a `hooks` object of matcher groups — the shape
 * settings.json and .codex/hooks.json share — pruning emptied groups, event
 * arrays, and the key itself. True when anything was removed.
 */
function stripHookGroups(config: Obj): boolean {
  if (!isObj(config.hooks)) return false
  const hooks = config.hooks
  let changed = false
  // Scan EVERY event key, not just ours — a user may have moved an entry.
  for (const eventName of Object.keys(hooks)) {
    const entries = hooks[eventName]
    if (!Array.isArray(entries)) continue
    const kept = entries.filter((entry) => {
      if (!isObj(entry) || !Array.isArray(entry.hooks)) return true // foreign shape — keep
      const remaining = entry.hooks.filter((h) => !isShimCommand(h))
      if (remaining.length === entry.hooks.length) return true // untouched
      changed = true
      if (remaining.length === 0) return false // emptied matcher group → drop
      entry.hooks = remaining
      return true
    })
    if (kept.length === 0) delete hooks[eventName] // emptied event array → drop key
    else hooks[eventName] = kept
  }
  if (changed && Object.keys(hooks).length === 0) delete config.hooks
  return changed
}

function stripSettings(rootDir: string, purge: boolean, report: string[]): boolean {
  const path = join(rootDir, '.claude', 'settings.json')
  if (!existsSync(path)) return false
  const settings = readJSONObject(path, '.claude/settings.json')

  const removedParts: string[] = []

  if (stripHookGroups(settings)) removedParts.push('hook entries')

  // statusLine: ours iff what `init --statusline` installs, by type +
  // command — a customized entry is user config, kept (theirs-wins,
  // mirrored from init).
  if (isSofarStatusline(settings.statusLine)) {
    delete settings.statusLine
    removedParts.push('statusLine')
  }

  if (removedParts.length === 0) return false
  const what = `sofar ${removedParts.join(' + ')} removed`
  if (purge && Object.keys(settings).length === 0) {
    drop(path)
    report.push(`removed .claude/settings.json (nothing left after ${what})`)
    return true
  }
  put(path, stableJSON(rootDir, '.claude/settings.json', settings))
  report.push(`updated .claude/settings.json (${what})`)
  return false
}

/** `.mcp.json` (Claude Code) or `.cursor/mcp.json` (Cursor, r1-fixes 6.2) — the same entry, stripped the same way. */
function stripMcp(rootDir: string, rel: string, purge: boolean, report: string[]): boolean {
  const path = join(rootDir, rel)
  if (!existsSync(path)) return false
  const config = readJSONObject(path, rel)
  if (!isObj(config.mcpServers) || !('sofar' in config.mcpServers)) return false

  delete config.mcpServers.sofar
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
  if (purge && Object.keys(config).length === 0) {
    drop(path)
    report.push(`removed ${rel} (nothing left after sofar server entry removed)`)
    return true
  }
  put(path, stableJSON(rootDir, rel, config))
  report.push(`updated ${rel} (sofar server entry removed)`)
  return false
}

/**
 * Strip sofar's entries from .cursor/hooks.json (r1-fixes 6.6) — Cursor's
 * entries are flat `{command, …}` objects, matched by the same shim command
 * test as settings.json. A file left holding only `version` carries no
 * configuration, so --purge removes it.
 */
function stripCursorHooks(rootDir: string, purge: boolean, report: string[]): boolean {
  const rel = '.cursor/hooks.json'
  const path = join(rootDir, rel)
  if (!existsSync(path)) return false
  const config = readJSONObject(path, rel)
  if (!isObj(config.hooks)) return false
  const hooks = config.hooks

  let changed = false
  for (const eventName of Object.keys(hooks)) {
    const entries = hooks[eventName]
    if (!Array.isArray(entries)) continue
    const kept = entries.filter((entry) => !isShimCommand(entry))
    if (kept.length === entries.length) continue
    changed = true
    if (kept.length === 0) delete hooks[eventName]
    else hooks[eventName] = kept
  }
  if (!changed) return false
  if (Object.keys(hooks).length === 0) delete config.hooks
  const leftover = Object.keys(config).filter((key) => key !== 'version')
  if (purge && leftover.length === 0) {
    drop(path)
    report.push(`removed ${rel} (nothing left after sofar hook entries removed)`)
    return true
  }
  put(path, stableJSON(rootDir, rel, config))
  report.push(`updated ${rel} (sofar hook entries removed)`)
  return false
}

/** Strip sofar's entries from .codex/hooks.json (agents-parity 2.1) — settings.json's shape, stripped the same way. */
function stripCodexHooks(rootDir: string, purge: boolean, report: string[]): boolean {
  const rel = '.codex/hooks.json'
  const path = join(rootDir, rel)
  if (!existsSync(path)) return false
  const config = readJSONObject(path, rel)
  if (!stripHookGroups(config)) return false
  if (purge && Object.keys(config).length === 0) {
    drop(path)
    report.push(`removed ${rel} (nothing left after sofar hook entries removed)`)
    return true
  }
  put(path, stableJSON(rootDir, rel, config))
  report.push(`updated ${rel} (sofar hook entries removed)`)
  return false
}

/**
 * Remove sofar's server from .codex/config.toml (agents-parity 2.2, D7): the
 * `[mcp_servers.sofar]` tables, cut out where the structure scanner finds
 * them so every other byte stays. Unlike unparseable JSON, a file the scanner
 * cannot follow does not abort the run — TOML here is scanned, never parsed
 * whole, so a valid file can still defeat the scanner — but it is left alone,
 * with a warning when it mentions sofar. A sofar server in another form is not
 * a table init writes; it is named, not edited.
 */
function stripCodexMcp(rootDir: string, purge: boolean, report: string[], warnings: string[]): boolean {
  const path = join(rootDir, CODEX_CONFIG)
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  // The direct-call table init appends after the server (r3-fixes 2.7) goes
  // first, so each cut takes its own seam line and the file comes back whole.
  const direct = withoutSofarDirect(text)
  const stripped = direct === null ? null : withoutSofarServer(direct)
  if (stripped === null) {
    if (text.includes('sofar')) {
      warnings.push(`warning: ${CODEX_CONFIG} could not be read as TOML — any sofar MCP server in it was left; remove it by hand`)
    }
    return false
  }
  if (codexMcpState(stripped) === 'registered') {
    warnings.push(`warning: ${CODEX_CONFIG} defines a sofar MCP server outside a [mcp_servers.sofar] table — left; remove it by hand`)
  }
  if (stripped === text) return false
  if (purge && stripped.length === 0) {
    drop(path)
    report.push(`removed ${CODEX_CONFIG} (nothing left after sofar server entry removed)`)
    return true
  }
  put(path, stripped)
  report.push(`updated ${CODEX_CONFIG} (sofar server entry removed)`)
  return false
}

/**
 * Remove the marker-delimited protocol block INCLUSIVE of markers, plus
 * exactly one adjacent blank-line seam (init separated user content from the
 * block with a blank line — collapsing it restores pre-init spacing). All
 * content outside the markers is byte-preserved.
 */
function stripProtocolBlock(
  rootDir: string,
  file: string,
  purge: boolean,
  report: string[],
  warnings: string[],
): void {
  const path = join(rootDir, file)
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  const start = content.indexOf(PROTOCOL_START)
  if (start === -1) return
  const endMarker = content.indexOf(PROTOCOL_END, start)
  if (endMarker === -1) {
    warnings.push(
      `warning: ${file} has a ${PROTOCOL_START} marker but no ${PROTOCOL_END} — left untouched`,
    )
    return
  }
  let end = endMarker + PROTOCOL_END.length
  if (content[end] === '\n') end += 1 // the block's own trailing newline
  let before = content.slice(0, start)
  if (before.endsWith('\n\n')) before = before.slice(0, -1) // the one seam blank line
  const result = before + content.slice(end)

  if (purge && result.length === 0) {
    drop(path)
    report.push(`removed ${file} (contained only the sofar protocol block)`)
    return
  }
  put(path, result)
  report.push(`updated ${file} (sofar protocol block removed)`)
}

/**
 * Remove exactly the union-merge lines init installed (team-readiness T2, r3-fixes 2.1).
 * A user-customized rule for one of our patterns differs byte-wise and is therefore
 * user content — kept, like every other foreign line.
 */
function stripGitattributes(rootDir: string, purge: boolean, report: string[]): void {
  const path = join(rootDir, '.gitattributes')
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  const lines = content.split('\n')
  const kept = lines.filter((line) => !GITATTRIBUTES_LINES.includes(line.trimEnd()))
  if (kept.length === lines.length) return // no line of ours — untouched
  const result = kept.join('\n')

  if (purge && result.length === 0) {
    drop(path)
    report.push('removed .gitattributes (contained only the sofar union-merge rules)')
    return
  }
  put(path, result)
  report.push('updated .gitattributes (sofar union-merge rules removed)')
}

/**
 * The `sofar-write` skill init wrote (r4-fixes A2), only while it holds the
 * bytes a sofar shipped — an edited skill is the user's — then the skill's
 * directories, each only if that left it empty. True when a file went.
 */
function removeWriteSkills(rootDir: string, report: string[]): boolean {
  let removed = false
  for (const rel of Object.values(WRITE_SKILL_PATHS)) {
    const path = join(rootDir, rel)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (text !== WRITE_SKILL && !SHIPPED_WRITE_SKILLS.includes(text)) continue
    unlinkSync(path)
    report.push(`removed ${rel}`)
    removed = true
    const skills = rel.slice(0, rel.indexOf('/skills/') + '/skills'.length)
    if (removeDirIfEmpty(rootDir, `${skills}/${WRITE_SKILL_NAME}`, report) && removeDirIfEmpty(rootDir, skills, report)) {
      if (skills.startsWith('.agents/')) removeDirIfEmpty(rootDir, '.agents', report)
    }
  }
  return removed
}

/** Remove a directory ONLY when it exists and is empty. */
function removeDirIfEmpty(rootDir: string, rel: string, report: string[]): boolean {
  const path = join(rootDir, rel)
  if (!existsSync(path) || readdirSync(path).length > 0) return false
  rmdirSync(path)
  report.push(`removed ${rel}/ (empty)`)
  return true
}

// ---------------------------------------------------------------------------
// Confirmation styling (cli-ui 2.5). Wording is identical styled or plain —
// caps only add the ✓/✗ mark, color, dim └ rails on the detail/notice lines,
// and warn color on stderr warnings — so piped output stays byte-identical
// to the unstyled report. Failure and warning text lands on stderr, so it
// styles under the STDERR stream's caps (errCaps): a stdout TTY must not
// push escapes into a redirected stderr.
// ---------------------------------------------------------------------------

function renderReport(details: string[], result: string, caps: Caps): string {
  if (!caps.color) return [...details, result].join('\n')
  const style = createStyle(true)
  const symbols = symbolsFor(caps.unicode)
  return [
    ...details.map((line) => style.dim(`  ${symbols.elbow} ${line}`)),
    `${style.success(symbols.ok)} ${result}`,
  ].join('\n')
}

function renderFailure(message: string, caps: Caps): string {
  if (!caps.color) return message
  return `${createStyle(true).error(symbolsFor(caps.unicode).fail)} ${message}`
}

function renderWarnings(warnings: string[], caps: Caps): string {
  if (!caps.color) return warnings.join('\n')
  const style = createStyle(true)
  return warnings.map((line) => style.warn(line)).join('\n')
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export function runUninit(
  rootDir: string,
  options: UninitOptions = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  if (options.agent !== undefined) {
    if (options.purge === true) {
      return fail(renderFailure('sofar uninit: --purge deletes the record, --agent removes one agent — pass one, not both', errCaps))
    }
    return runUninitAgent(rootDir, options.agent, options, caps, errCaps)
  }
  const purge = options.purge === true
  const report: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const lines = options.journal === undefined ? [] : readWiringJournalLines(rootDir, options.journal.env)
  const consent = consentOf(lines)
  runChanges = []
  let aborted = false

  try {
    const shimsRemoved = removeShims(rootDir, SHIM_HOMES.claude.dir, report)
    const cursorShimsRemoved = removeShims(rootDir, SHIM_HOMES.cursor.dir, report)
    const codexShimsRemoved = removeShims(rootDir, CODEX_SHIM_DIR, report, CODEX_SHIMS)
    removeGitHook(rootDir, report)
    const settingsDeleted = stripSettings(rootDir, purge, report)
    stripMcp(rootDir, '.mcp.json', purge, report)
    const cursorHooksDeleted = stripCursorHooks(rootDir, purge, report)
    const cursorMcpDeleted = stripMcp(rootDir, '.cursor/mcp.json', purge, report)
    const codexHooksDeleted = stripCodexHooks(rootDir, purge, report)
    const codexConfigDeleted = stripCodexMcp(rootDir, purge, report, warnings)
    stripGitattributes(rootDir, purge, report)
    stripProtocolBlock(rootDir, 'CLAUDE.md', purge, report, warnings)
    stripProtocolBlock(rootDir, 'AGENTS.md', purge, report, warnings)
    const skillsRemoved = removeWriteSkills(rootDir, report)

    // Directory cleanup — only dirs THIS run may have emptied, never a dir
    // that was already empty before uninit touched anything.
    const hooksDirRemoved = shimsRemoved > 0 && removeDirIfEmpty(rootDir, '.claude/hooks', report)
    if (hooksDirRemoved || settingsDeleted || skillsRemoved) removeDirIfEmpty(rootDir, '.claude', report)
    const cursorShimDirRemoved =
      cursorShimsRemoved > 0 &&
      removeDirIfEmpty(rootDir, SHIM_HOMES.cursor.dir, report) &&
      removeDirIfEmpty(rootDir, '.cursor/hooks', report)
    if (cursorHooksDeleted || cursorMcpDeleted || cursorShimDirRemoved) {
      removeDirIfEmpty(rootDir, '.cursor', report)
    }
    const codexShimDirRemoved =
      codexShimsRemoved > 0 &&
      removeDirIfEmpty(rootDir, CODEX_SHIM_DIR, report) &&
      removeDirIfEmpty(rootDir, '.codex/hooks', report)
    if (codexHooksDeleted || codexConfigDeleted || codexShimDirRemoved) removeDirIfEmpty(rootDir, '.codex', report)

    const sofarDir = join(rootDir, '.sofar')
    if (existsSync(sofarDir)) {
      if (purge) {
        rmSync(sofarDir, { recursive: true, force: true })
        runChanges.push({ path: sofarDir, op: 'remove' })
        report.push('removed .sofar/ (record deleted)')
        warnings.push(
          'warning: --purge deleted the sofar record (.sofar/) — this is irreversible; `sofar export` before purging is the backup path.',
        )
      } else {
        notes.push('record kept at .sofar/ (use --purge to delete it)')
      }
    }
  } catch (err) {
    aborted = true
    if (err instanceof UninitAbort) {
      return fail(renderFailure(`sofar uninit: ${err.message}`, errCaps))
    }
    throw err
  } finally {
    // Every agent's wiring goes, so every agent's choice is withdrawn.
    journalUninit(rootDir, options, [...AGENTS], aborted, consent.chosen.size > 0 && !aborted, null)
  }

  const changes = report.length
  const result =
    changes === 0
      ? 'sofar uninit: nothing to remove'
      : `sofar uninit: done (${changes} change${changes === 1 ? '' : 's'})`
  return ok(
    `${renderReport([...report, ...notes], result, caps)}\n`,
    renderWarnings(warnings, errCaps),
  )
}

// ---------------------------------------------------------------------------
// The journal line every uninit that changes something leaves (r4-fixes A11).
// ---------------------------------------------------------------------------

/**
 * Append this run's line: the agents whose wiring it removed (and whose choice
 * it withdraws), and every file it rewrote or removed. `force` journals a run
 * that changed no file but withdrew a standing choice.
 */
function journalUninit(
  rootDir: string,
  options: UninitOptions,
  agents: AgentId[],
  aborted: boolean,
  force: boolean,
  adopted: AgentId[] | null,
): void {
  const changes = runChanges ?? []
  runChanges = null
  const j = options.journal
  if (j === undefined || (changes.length === 0 && !force)) return
  appendWiringEntry(
    rootDir,
    {
      ts: (j.now ?? (() => new Date().toISOString()))(),
      sofar: SOFAR_VERSION,
      root: rootDir,
      cwd: j.cwd,
      argv: [...j.argv],
      tty: j.tty,
      command: 'uninit',
      agents,
      // The clone's first consent-era line keeps the other wired agents chosen.
      ...(adopted === null ? {} : { adopted }),
      result: aborted ? 'aborted' : 'ok',
      files: changes.map((c) => ({ ...c, path: journalPath(rootDir, c.path) })),
    },
    j.env,
  )
}

// ---------------------------------------------------------------------------
// `sofar uninit --agent <id>` (r4-fixes A11): the journal's writes, reversed.
// ---------------------------------------------------------------------------

/** Each agent's own config files; AGENTS.md is Cursor's and Codex's both. */
const AGENT_FILES: Record<AgentId, readonly string[]> = {
  'claude-code': ['.claude/settings.json', '.mcp.json', 'CLAUDE.md'],
  cursor: ['.cursor/hooks.json', '.cursor/mcp.json', 'AGENTS.md'],
  codex: ['.codex/hooks.json', CODEX_CONFIG, 'AGENTS.md'],
}

/** The shim dirs an agent's hooks may run: Cursor runs Claude Code's whenever Claude Code is wired (D36). */
const AGENT_SHIM_DIRS: Record<AgentId, readonly string[]> = {
  'claude-code': [SHIM_HOMES.claude.dir],
  cursor: [SHIM_HOMES.cursor.dir, SHIM_HOMES.claude.dir],
  codex: [CODEX_SHIM_DIR],
}

/** Dirs an agent's files sit in, deepest first: each goes only if this run emptied it. */
const AGENT_DIRS: Record<AgentId, readonly string[]> = {
  'claude-code': [SHIM_HOMES.claude.dir, '.claude'],
  cursor: [SHIM_HOMES.cursor.dir, '.cursor/hooks', SHIM_HOMES.claude.dir, '.claude', '.cursor'],
  codex: [CODEX_SHIM_DIR, '.codex/hooks', '.codex'],
}

function readTextOr(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Does a hook config left in this repo still run a shim from `dir`? */
function shimDirInUse(rootDir: string, dir: string): boolean {
  return ['.claude/settings.json', '.cursor/hooks.json', '.codex/hooks.json'].some((rel) =>
    readTextOr(join(rootDir, rel)).includes(`${dir}/`),
  )
}

function runUninitAgent(rootDir: string, agent: AgentId, options: UninitOptions, caps: Caps, errCaps: Caps): CmdResult {
  const lines = readWiringJournalLines(rootDir, options.journal?.env)
  const ledger = writtenFiles(lines)
  const consent = consentOf(lines)
  const wiredBefore = wiredAgents(rootDir)
  const remaining = new Set(wiredBefore.filter((id) => id !== agent))
  const label = AGENT_LABELS[agent]
  const report: string[] = []
  const warnings: string[] = []
  const left: string[] = []
  const journaled = (rel: string): boolean => ledger.has(rel)
  const created = (rel: string): boolean => ledger.get(rel)?.created === true
  const chosen = consent.recorded ? consent.chosen.has(agent) : wiredBefore.includes(agent)
  runChanges = []
  let aborted = false

  try {
    for (const rel of AGENT_FILES[agent]) {
      // AGENTS.md goes with the last agent reading it.
      if (rel === 'AGENTS.md' && (remaining.has('cursor') || remaining.has('codex'))) continue
      if (!existsSync(join(rootDir, rel))) continue
      if (!journaled(rel)) {
        const text = readTextOr(join(rootDir, rel))
        if (text.includes('sofar') || SHIM_PATH_SUBSTRINGS.some((path) => text.includes(path))) left.push(rel)
        continue
      }
      const purge = created(rel)
      if (rel === '.claude/settings.json') stripSettings(rootDir, purge, report)
      else if (rel === '.mcp.json' || rel === '.cursor/mcp.json') stripMcp(rootDir, rel, purge, report)
      else if (rel === '.cursor/hooks.json') stripCursorHooks(rootDir, purge, report)
      else if (rel === '.codex/hooks.json') stripCodexHooks(rootDir, purge, report)
      else if (rel === CODEX_CONFIG) stripCodexMcp(rootDir, purge, report, warnings)
      else stripProtocolBlock(rootDir, rel, purge, report, warnings)
    }
    // A shim goes only when no hook config left here runs its dir, and only
    // while its bytes are still the ones the journal says sofar wrote.
    for (const dir of AGENT_SHIM_DIRS[agent]) {
      if (shimDirInUse(rootDir, dir)) continue
      for (const shim of dir === CODEX_SHIM_DIR ? CODEX_SHIMS : SHIMS) {
        const rel = `${dir}/${shim.file}`
        const path = join(rootDir, rel)
        if (!existsSync(path)) continue
        const written = ledger.get(rel)
        if (written === undefined || written.sha256 !== sha256Hex(readTextOr(path))) {
          left.push(rel)
          continue
        }
        drop(path)
        report.push(`removed ${rel}`)
      }
    }
    const touched = (runChanges ?? []).map((c) => journalPath(rootDir, c.path))
    for (const dir of AGENT_DIRS[agent]) {
      if (touched.some((rel) => rel.startsWith(`${dir}/`))) removeDirIfEmpty(rootDir, dir, report)
    }
  } catch (err) {
    aborted = true
    if (err instanceof UninitAbort) return fail(renderFailure(`sofar uninit --agent ${agent}: ${err.message}`, errCaps))
    throw err
  } finally {
    journalUninit(rootDir, options, [agent], aborted, chosen && !aborted, consent.recorded ? null : wiredBefore)
  }

  const leftLines = left.map((rel) => `left ${rel} — this clone's wiring journal records no sofar write to it as it stands`)
  if (report.length === 0) {
    if (!wiredBefore.includes(agent) && left.length === 0) {
      return ok(`${renderReport([], `sofar uninit --agent ${agent}: ${label} is not wired here — nothing to remove`, caps)}\n`)
    }
    return fail(
      renderFailure(
        [
          `sofar uninit --agent ${agent}: this clone's wiring journal records nothing sofar wrote for ${label}, so nothing was removed`,
          ...leftLines.map((line) => `  ${line}`),
          '  `sofar uninit` removes every agent\'s wiring, journaled or not',
        ].join('\n'),
        errCaps,
      ),
    )
  }
  const result = `sofar uninit --agent ${agent}: done (${report.length} change${report.length === 1 ? '' : 's'})`
  return ok(`${renderReport([...report, ...leftLines], result, caps)}\n`, renderWarnings(warnings, errCaps))
}
