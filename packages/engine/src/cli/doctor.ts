import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { version as CURRENT_VERSION } from '../../package.json'
import { isClosedInitiativeStatus, isResolvedTaskStatus } from '@sofar/schema'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  foldLog,
  openSessionFileConflicts,
  staleActivePhases,
  type InitiativeState,
  type OrphanTaskEvent,
} from '../core/fold'
import { effectiveHooksDir, readAttribution, unattributed } from '../core/attribution'
import { readBindingsFile } from '../core/bindings'
import { commonGitDir } from '../core/git'
import { crossConflictsFromStates } from '../core/cross-conflicts'
import { buildGraph, extractCitations, repoGeneral } from '../core/graph'
import { clip } from '../projections/templates/shared'
import { AGENT_LABELS, AGENTS, type AgentId } from './agents'
import {
  CODEX_CONFIG,
  CODEX_DIRECT_KEY,
  CODEX_MCP_ADD,
  CODEX_TOOLS_APPROVAL,
  codexConfigRegistersSofar,
  codexDirectState,
  type CodexMcpState,
  codexMcpState,
  codexSofarToolsApprovalSet,
  codexUserConfigPath,
} from './codex-config'
import {
  AGENTS_PROTOCOL_BLOCK,
  classifyProtocolBlock,
  CODEX_SHIM_DIR,
  CODEX_SHIMS,
  codexHookCommand,
  CURSOR_HOOKS,
  GITATTRIBUTES_LINES,
  hookCommand,
  PROTOCOL_BLOCK,
  SHIM_HOMES,
  shimHomeFor,
  SHIMS,
  shimsFor,
  SHIPPED_AGENTS_PROTOCOL_BLOCKS,
  SHIPPED_PROTOCOL_BLOCKS,
  wiredAgents,
} from './init'
import {
  cssExcludesSofar,
  detectTailwindV4,
  findTailwindCssEntries,
  insertSofarExclusion,
  sofarExclusionDirective,
  sofarScanBaseDirective,
  SOURCE_NOT_SINCE,
  type TailwindV4Detection,
} from './scanners'
import { CORE_PACKAGE, resolveCore, type ResolvedCore } from './core'
import type { StateEnv } from '../core/state-dir'
import {
  appendWiringEntry,
  consentOf,
  journalPath,
  readWiringJournalLines,
  sha256Hex,
  type WiringFile,
  wiringJournalPath,
} from './wiring-journal'
import { activateCore, type Activation } from './core-store'
import { planUpgrade } from './update-cache'
import { detectFormatterHazards } from './formatters'
import { errMessage, fail, ok, type CmdResult } from './shared'
import {
  createSpinner,
  createStyle,
  padEndVisible,
  stderrCaps,
  stdoutCaps,
  symbolsFor,
  visibleWidth,
  type Caps,
  type SpinnerStream,
  type Style,
} from './ui'
import { byCodeUnit } from '../core/order'
import { checksInForce, isApproved, type InForceCheck } from '../core/checks'
import { refreshGuards } from '../core/index-tier1'

/**
 * `sofar doctor [--fix]` (tasks 10.2/10.3 + 11.1/11.2/11.3) — audit a host repo:
 *   1. wiring integrity  — did init's artifacts survive? (shims, settings,
 *      .mcp.json, protocol blocks)
 *   2. record health     — logs fold without stub sessions or corrupt lines;
 *      no STALE PHASES (all tasks done but phase still open, 11.1); no
 *      UNTRACKED WORK (a wrapped session with real file activity but zero task
 *      changes — work missing from the plan, 11.3)
 *   3. concurrency        — no file under concurrent edit by ≥2 OPEN sessions
 *      (live clobber risk, 11.2)
 *   3b. decision guards   — has any work crossed a guarded rule (drift-hardening
 *      D3)? WARN only: a guard never moves an exit code, this one included.
 *   4. repo memory        — is every decision the record TREATS as repo-wide
 *      (cited from other initiatives, record-graph 2.3/3.3) named in the
 *      hand-written .sofar/repo.md? Both halves: decisions OBSERVED repo-general
 *      by cross-initiative citation, and facts DECLARED so by `sofar remember`
 *      (repo-memory-capture D1). Detection only: repo.md is never written.
 *   5. scanner hazards    — will a tree-wide class scanner (Tailwind v4)
 *      ingest .sofar/ because the entry stylesheet lacks a `@source not`
 *      exclusion?
 *
 * --fix is scoped to the ONE deterministic, safe repair (D-P10): inserting the
 * `@source not` exclusion after the `@import "tailwindcss"` line in each
 * unprotected entry stylesheet. Wiring gaps are reported, never auto-repaired
 * (re-run `sofar init` for those); the fix never touches record prose. It is
 * additionally version-gated (scanner-version-gate D1): `@source not` needs Tailwind >= 4.1, so
 * on 4.0.x — or when the resolved version cannot be established — the hazard is
 * reported with the pre-4.1 remedy and nothing is written.
 *
 * Exit code: 1 when any FAIL-level finding remains after fixes (so CI can gate
 * on it); 0 on a clean repo. WARN findings surface without failing.
 *
 * Rendering (cli-ui 2.4) is capability-gated: `caps.color` picks the styled
 * report (✓/⚠/✗ level marks, bold sections, dim └ hints) — the styled layout
 * is inherently color-coded (D1), so piped/NO_COLOR output keeps the
 * pre-styling plain bytes. A scan spinner covers the tree walk on stderr.
 */

export interface DoctorOptions {
  /** Apply the safe repairs: the Tailwind `@source not` insertion and the formatter/linter `.sofar` exclusions. */
  fix?: boolean
  /** Home directory override for the Codex user-config check. Tests only — production reads CODEX_HOME or os.homedir(). */
  home?: string
  /**
   * Who ran this doctor, for the wiring journal (r4-fixes A11): a `--fix`
   * that writes is journaled, and the journal is where each wired host's
   * choice is read from. `env` overrides the state dir — tests only.
   */
  journal?: { argv: readonly string[]; cwd: string; tty: boolean; env?: StateEnv; now?: () => string }
}

/** Progress channel for the tree-scan spinner — injectable for tests. */
export interface DoctorProgress {
  /** Spinner caps (default: stderrCaps() — progress lives on stderr). */
  caps?: Caps
  /** Spinner sink (default: process.stderr). */
  stream?: SpinnerStream
}

export type Level = 'ok' | 'warn' | 'fail'

export interface Finding {
  level: Level
  text: string
  /** Optional indented follow-up line (a fix suggestion or detail). */
  hint?: string
  /** True when --fix just applied this repair — counted in the summary. */
  fixed?: boolean
}

interface Section {
  title: string
  findings: Finding[]
}

const MARKER: Record<Level, string> = { ok: '  ok  ', warn: '  WARN', fail: '  FAIL' }

// ---------------------------------------------------------------------------
// 1. Wiring integrity.
// ---------------------------------------------------------------------------

function fileHas(path: string, needle: string): boolean {
  if (!existsSync(path)) return false
  try {
    return readFileSync(path, 'utf8').includes(needle)
  } catch {
    return false
  }
}

function mcpHasSofar(rootDir: string, rel: string): boolean {
  const path = join(rootDir, rel)
  if (!existsSync(path)) return false
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return (
      typeof cfg === 'object' &&
      cfg !== null &&
      typeof (cfg as Record<string, unknown>).mcpServers === 'object' &&
      (cfg as { mcpServers: Record<string, unknown> }).mcpServers !== null &&
      'sofar' in (cfg as { mcpServers: Record<string, unknown> }).mcpServers
    )
  } catch {
    return false
  }
}

/**
 * Is commit attribution actually working? (2.4)
 *
 * Deliberately EMPIRICAL rather than diagnostic. Attribution can be silently
 * off for several unrelated reasons — the hook was never installed (a fresh
 * clone never gets one, since `.git/hooks` is not cloned), the `sofar` on PATH
 * predates the `commit-trailer` subcommand so the shim's `|| true` swallows the
 * failure, or CLAUDE_CODE_SESSION_ID stopped being exported. Enumerating causes
 * would miss the next one. Asking "do recent commits actually carry trailers"
 * catches all of them, including causes nobody has thought of yet.
 *
 * Never FAIL: unattributed commits are legitimately normal (every commit made
 * before adopting this, and every commit made from a plain terminal). A
 * permanently red doctor trains people to ignore it — record-integrity D3.
 *
 * Bounded per D6: a fixed, small window, never a full-history walk.
 */
const ATTRIBUTION_WINDOW = 20

function auditAttribution(rootDir: string, findings: Finding[]): void {
  const dir = commonGitDir(rootDir) // hooks live in the COMMON dir, not a worktree's own
  if (dir === null) return // not a git repo — nothing to attribute
  // Where git will actually look, which is not always `<common>/hooks`: a repo
  // using husky or lefthook points core.hooksPath elsewhere, and checking the
  // default would report attribution off while a hand-installed hook works.
  const hooks = effectiveHooksDir(rootDir, dir)
  const hook = join(hooks.dir, 'prepare-commit-msg')
  // A configured path that is not there is not "no hook": git skips a missing
  // hooksPath silently, so EVERY hook is off, and `sofar init` cannot help
  // because it will not write outside <common>/hooks. Found in the field
  // (splen 2026-09-14, push-ping-reach 1.2): a repo moved from brillo kept an
  // absolute path to its old home and lost attribution for two days.
  if (hooks.configured !== null && !existsSync(hooks.dir)) {
    findings.push({
      level: 'warn',
      text: `commit attribution off — core.hooksPath is ${hooks.configured}, which does not exist, so git runs no hooks at all`,
      hint: 'a moved or renamed repo keeps an absolute hooksPath to its old home: `git config --unset core.hooksPath` (or point it at a real directory), then run `sofar init`',
    })
    return
  }
  if (!existsSync(hook)) {
    findings.push({
      level: 'warn',
      text: 'commit attribution off — no prepare-commit-msg hook',
      hint: 'run `sofar init` to install it; commits will not be linked to their initiative',
    })
    return
  }

  const commits = readAttribution(rootDir, { maxCount: ATTRIBUTION_WINDOW })
  if (commits === null || commits.length === 0) return // no history to judge
  const blank = unattributed(commits).length
  if (blank < commits.length) {
    findings.push({
      level: 'ok',
      text: `commit attribution live (${commits.length - blank}/${commits.length} recent commits attributed)`,
    })
    return
  }
  findings.push({
    level: 'warn',
    text: `prepare-commit-msg installed but the last ${commits.length} commits carry no attribution`,
    hint: 'the hook exits 0 on every failure, so this is silent: check that the `sofar` on PATH has `commit-trailer` (`sofar commit-trailer --help`) and that commits are made from a registered session',
  })
}

/**
 * Every shim present: are they this release's bytes? A shim from an older
 * sofar still routes every hook, but misses what this one routes to — since
 * r4-fixes A12, the native core activated for this user, without which a
 * hook keeps paying node's boot on an install whose scripts did not run.
 */
function shimsCurrent(
  rootDir: string,
  dir: string,
  expected: readonly { file: string; text: string }[],
  label: string,
  repair: string,
): Finding {
  const stale = expected.filter((shim) => {
    try {
      return readFileSync(join(rootDir, dir, shim.file), 'utf8') !== shim.text
    } catch {
      return false
    }
  })
  if (stale.length === 0) return { level: 'ok', text: `${label} installed (${expected.length}/${expected.length})` }
  return {
    level: 'warn',
    text: `${label} installed, but ${stale.length} of ${expected.length} are from another sofar: ${stale.map((shim) => shim.file).join(', ')}`,
    hint: repair.replace('(re)install it', 'refresh them'),
  }
}

/**
 * The wiring journal entry behind each wired host (r4-fixes A11): the line
 * that chose it (or adopted it), cited as `<journal>:<line>` so "who wired
 * this?" is one look. A wired host no line chose is a WARN — init leaves it
 * as it is — with the two ways out; a clone whose journal predates consent
 * gets one line saying so.
 */
function auditJournal(rootDir: string, wired: readonly AgentId[], findings: Finding[], env: StateEnv | undefined): void {
  if (wired.length === 0) return
  const path = wiringJournalPath(rootDir, env)
  if (path === null) return
  const consent = consentOf(readWiringJournalLines(rootDir, env))
  if (!consent.recorded) {
    findings.push({
      level: 'ok',
      text: `wiring journal: no choice recorded yet for ${wired.map((id) => AGENT_LABELS[id]).join(', ')} (wired before the journal) — the next init that writes records ${wired.length === 1 ? 'it' : 'them'} as chosen`,
    })
    return
  }
  for (const id of wired) {
    const by = consent.chosen.get(id)
    if (by === undefined) {
      findings.push({
        level: 'warn',
        text: `${AGENT_LABELS[id]} is wired here, but this clone's wiring journal records no choice of it — init leaves it as it is`,
        hint: `\`sofar init --agents ${id}\` records the choice and refreshes it; \`sofar uninit --agent ${id}\` removes what sofar wrote`,
      })
      continue
    }
    const run = `sofar ${by.entry.argv.join(' ')}`.trim()
    findings.push({
      level: 'ok',
      text: `${AGENT_LABELS[id]} ${by.how} by \`${run}\` (${by.entry.tty ? 'terminal' : 'no terminal'}, ${by.entry.ts}) — ${path}:${by.line}`,
    })
  }
}

function auditWiring(rootDir: string, userHome: string | undefined, journalEnv?: StateEnv): Section {
  const findings: Finding[] = []

  // Per agent (r1-fixes 7.1, D36): a repo is checked only for the agents it is
  // wired for, and each agent it is not wired for is named with the command
  // that adds it — a Cursor-only repo is not missing Claude Code's files.
  const wired = new Set(wiredAgents(rootDir))
  // A wired repo is repaired by rewiring exactly its wired set (r4-fixes
  // R12): `--refresh` never asks and never adds an agent, so the hint is safe
  // for an agent's shell to run as it stands.
  const repair = wired.size === 0 ? 'run `sofar init` to (re)install it' : 'run `sofar init --refresh` to (re)install it'

  const bindings = join(rootDir, '.sofar', 'bindings.json')
  findings.push(
    existsSync(bindings)
      ? { level: 'ok', text: '.sofar/bindings.json present' }
      : { level: 'fail', text: '.sofar/bindings.json missing', hint: repair },
  )

  if (wired.size === 0) {
    findings.push({
      level: 'fail',
      text: `no agent wired (${AGENTS.map((id) => AGENT_LABELS[id]).join(', ')})`,
      hint: 'run `sofar init` to set one up',
    })
  }
  const claude = wired.has('claude-code')
  const cursor = wired.has('cursor')
  const home = shimHomeFor(rootDir, wired)

  if (claude || cursor) {
    const { dir } = SHIM_HOMES[home]
    // Claude Code's set includes the rewake shim; every other host's does not (3.7).
    const expected = shimsFor(home)
    const missingShims = expected.filter((shim) => !existsSync(join(rootDir, dir, shim.file))).map(
      (shim) => shim.file,
    )
    findings.push(
      missingShims.length === 0
        ? shimsCurrent(rootDir, dir, expected, 'hook shims', repair)
        : { level: 'fail', text: `hook shims missing: ${missingShims.join(', ')}`, hint: repair },
    )
  }

  if (claude) {
    const settingsPath = join(rootDir, '.claude', 'settings.json')
    const missingHooks = SHIMS.filter((shim) => !fileHas(settingsPath, hookCommand(shim.file))).map(
      (shim) => shim.event,
    )
    findings.push(
      missingHooks.length === 0
        ? { level: 'ok', text: '.claude/settings.json hooks wired' }
        : { level: 'fail', text: `.claude/settings.json missing hooks: ${missingHooks.join(', ')}`, hint: repair },
    )

    findings.push(
      mcpHasSofar(rootDir, '.mcp.json')
        ? { level: 'ok', text: '.mcp.json sofar server registered' }
        : { level: 'fail', text: '.mcp.json sofar server not registered', hint: repair },
    )
  }

  // Cursor's copies (r1-fixes 6.2/6.6, D34). Cursor reads neither .mcp.json nor
  // a hook it cannot dedupe against, so each is checked in Cursor's own file.
  if (cursor) {
    const cursorHooksPath = join(rootDir, '.cursor', 'hooks.json')
    // Cursor's set excludes the Claude-only rewake shim (3.7).
    const missingCursorHooks = shimsFor('cursor')
      .filter((shim) => !fileHas(cursorHooksPath, hookCommand(shim.file, home)))
      .map((shim) => CURSOR_HOOKS[shim.event].event)
    findings.push(
      missingCursorHooks.length === 0
        ? { level: 'ok', text: '.cursor/hooks.json hooks wired' }
        : { level: 'fail', text: `.cursor/hooks.json missing hooks: ${missingCursorHooks.join(', ')}`, hint: repair },
    )
    findings.push(
      mcpHasSofar(rootDir, '.cursor/mcp.json')
        ? { level: 'ok', text: '.cursor/mcp.json sofar server registered' }
        : { level: 'fail', text: '.cursor/mcp.json sofar server not registered', hint: repair },
    )
  }

  // Codex's own shims and hooks.json (agents-parity 2.1, D5). The command is
  // matched as it sits in the file, JSON-escaped, since it opens with a quote.
  if (wired.has('codex')) {
    const missingCodexShims = CODEX_SHIMS.filter(
      (shim) => !existsSync(join(rootDir, CODEX_SHIM_DIR, shim.file)),
    ).map((shim) => shim.file)
    findings.push(
      missingCodexShims.length === 0
        ? shimsCurrent(rootDir, CODEX_SHIM_DIR, CODEX_SHIMS, 'Codex hook shims', repair)
        : { level: 'fail', text: `Codex hook shims missing: ${missingCodexShims.join(', ')}`, hint: repair },
    )
    const codexHooksPath = join(rootDir, '.codex', 'hooks.json')
    const missingCodexHooks = CODEX_SHIMS.filter(
      (shim) => !fileHas(codexHooksPath, JSON.stringify(codexHookCommand(shim.file))),
    ).map((shim) => shim.event)
    findings.push(
      missingCodexHooks.length === 0
        ? { level: 'ok', text: '.codex/hooks.json hooks wired' }
        : { level: 'fail', text: `.codex/hooks.json missing hooks: ${missingCodexHooks.join(', ')}`, hint: repair },
    )
    // Its MCP server (2.2, D7): the project's .codex/config.toml, or the user's
    // config.toml, where `codex mcp add` puts it when the project file cannot
    // take sofar's table. The hint names whichever of the two will work.
    const configPath = join(rootDir, CODEX_CONFIG)
    let state: CodexMcpState = 'unreadable'
    try {
      state = existsSync(configPath) ? codexMcpState(readFileSync(configPath, 'utf8')) : 'absent'
    } catch {
      // an unreadable file stays 'unreadable'
    }
    if (state === 'registered') {
      findings.push({ level: 'ok', text: `${CODEX_CONFIG} sofar server registered` })
      // 3.4: a table from an older init lacks the approval key, so `codex exec`
      // refuses every sofar tool call. The table is the user's (D7): name the line.
      let approvalSet = true
      try {
        approvalSet = codexSofarToolsApprovalSet(readFileSync(configPath, 'utf8'))
      } catch {
        // registered was read from this file; a vanished file is not this check's finding
      }
      if (!approvalSet) {
        findings.push({
          level: 'warn',
          text: `${CODEX_CONFIG} sofar tools not pre-approved — codex exec and driven sessions refuse sofar's MCP calls`,
          hint: `add \`${CODEX_TOOLS_APPROVAL}\` under [mcp_servers.sofar] in ${CODEX_CONFIG}`,
        })
      }
      // r3-fixes 2.7: without the direct namespace, Codex's code mode hides
      // sofar's tools inside its one exec tool, and the agent writes through
      // the CLI dialect instead.
      let direct = 'set'
      try {
        direct = codexDirectState(readFileSync(configPath, 'utf8'))
      } catch {
        // as above
      }
      if (direct !== 'set') {
        findings.push({
          level: 'warn',
          text: `${CODEX_CONFIG} Codex reaches sofar's tools only through code mode's exec tool`,
          hint: `add \`${CODEX_DIRECT_KEY}\` under [features.code_mode] in ${CODEX_CONFIG}`,
        })
      }
    } else if (codexConfigRegistersSofar(codexUserConfigPath(userHome))) {
      findings.push({ level: 'ok', text: 'Codex sofar server registered in your user config.toml' })
    } else {
      const why = state === 'blocked' ? 'defines mcp_servers outside [mcp_servers.<name>] tables' : 'is not TOML sofar can read'
      findings.push({
        level: 'fail',
        text: `${CODEX_CONFIG} sofar server not registered`,
        hint: state === 'absent' ? repair : `${CODEX_CONFIG} ${why}, so init leaves it — run \`${CODEX_MCP_ADD}\` once`,
      })
    }
  }

  // Presence is not enough (speed-2 T6): a block installed by an older sofar
  // keeps directing agents by the old protocol forever, and nothing else in the
  // repo reveals it — `sofar upgrade` replaces the binary, not repo wiring.
  const blocks = [
    ...(claude ? [{ file: 'CLAUDE.md', template: PROTOCOL_BLOCK, shipped: SHIPPED_PROTOCOL_BLOCKS }] : []),
    ...(cursor || wired.has('codex')
      ? [{ file: 'AGENTS.md', template: AGENTS_PROTOCOL_BLOCK, shipped: SHIPPED_AGENTS_PROTOCOL_BLOCKS }]
      : []),
  ]
  for (const { file, template, shipped } of blocks) {
    const path = join(rootDir, file)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    switch (classifyProtocolBlock(text, template, shipped)) {
      case 'current':
        findings.push({ level: 'ok', text: `${file} protocol block current` })
        break
      case 'stale':
        findings.push({
          level: 'warn',
          text: `${file} protocol block is from an older sofar`,
          hint: 'run `sofar init --refresh` to refresh it',
        })
        break
      case 'customized':
      case 'unterminated':
        // Not a fault — an edited block is the user's. Say so, so a repo that
        // silently misses protocol updates is at least visible.
        findings.push({
          level: 'warn',
          text: `${file} protocol block is customized — sofar will not refresh it`,
          hint: 'compare it against a fresh `sofar init` in a scratch repo',
        })
        break
      default:
        findings.push({ level: 'fail', text: `${file} protocol block missing`, hint: repair })
    }
  }

  if (wired.size > 0) {
    for (const id of AGENTS.filter((agent) => !wired.has(agent))) {
      findings.push({
        level: 'ok',
        text: `${AGENT_LABELS[id]} not set up — \`sofar init --agents ${id}\` adds it`,
      })
    }
  }

  auditJournal(rootDir, [...wired], findings, journalEnv)
  auditAttribution(rootDir, findings)
  auditGitattributes(rootDir, findings)
  auditCore(findings)

  return { title: 'Wiring integrity', findings }
}

/**
 * The merge rules (r3-fixes 2.14): every generated path — the event log, the
 * projections and, since memory-lead D45, brief.md and the shards — must
 * carry the attributes init writes, or a merge leaves them conflicted (round
 * 3's S18 merges: 6 per rep). Git is asked what actually applies to a path
 * each rule covers, so a later override, a nested .gitattributes or
 * core.attributesFile all count; where git cannot answer, .gitattributes is
 * read. A warning, never a failure: the record is safe either way, only a
 * merge is noisier. The fix names what `sofar init` appends — it never
 * touches a line the user wrote for one of our patterns — and, for those, the
 * line to make theirs read.
 */
export function auditGitattributes(rootDir: string, findings: Finding[]): void {
  const pattern = (line: string): string => line.split(' ')[0]!
  const probe = (line: string): string => pattern(line).replace('**', 'initiatives/doctor-probe').replace('*', 'probe')
  const wanted = (line: string): Array<[string, string]> =>
    line
      .split(/\s+/)
      .slice(1)
      .map((a): [string, string] => (a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, 'set']))
  const path = join(rootDir, '.gitattributes')
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = content.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
  const ours = new Set(lines.map((l) => l[0]))

  const r = spawnSync('git', ['check-attr', 'merge', 'linguist-generated', '--', ...GITATTRIBUTES_LINES.map(probe)], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const applied = (line: string, attr: string, value: string): boolean => {
    if (r.error === undefined && r.status === 0) return r.stdout.split('\n').includes(`${probe(line)}: ${attr}: ${value}`)
    // No git to ask: the rule's own line must be there, carrying the attribute.
    const token = value === 'set' ? attr : `${attr}=${value}`
    return lines.some((l) => l[0] === pattern(line) && l.includes(token))
  }
  const short = GITATTRIBUTES_LINES.filter((line) => wanted(line).some(([attr, value]) => !applied(line, attr, value)))
  if (short.length === 0) {
    findings.push({ level: 'ok', text: `.gitattributes merges every generated sofar path clean (${GITATTRIBUTES_LINES.length} rules)` })
    return
  }
  const addable = short.filter((line) => !ours.has(pattern(line)))
  const owned = short.filter((line) => ours.has(pattern(line)))
  const hint: string[] = []
  if (addable.length > 0) hint.push('run `sofar init` to append them (it never touches your own lines), or add:', ...addable.map((l) => `  ${l}`))
  if (owned.length > 0) hint.push("your own line wins for these and init leaves it; make it read:", ...owned.map((l) => `  ${l}`))
  findings.push({
    level: 'warn',
    text: `.gitattributes leaves ${short.length} of ${GITATTRIBUTES_LINES.length} generated sofar path(s) to a text merge, which can conflict on them`,
    hint: hint.join('\n'),
  })
}

/** npm 12 skips install scripts unless allowed (r4-fixes U9); this lets sofar.sh's run, for every later install. */
export const ALLOW_SCRIPTS_CONFIG = 'npm config set allow-scripts=sofar.sh --location=user'
export const ALLOW_SCRIPTS_INSTALL = 'npm install -g sofar.sh --allow-scripts=sofar.sh'

export interface CoreProbe {
  /** Environment for SOFAR_CORE — tests only. */
  env?: Record<string, string | undefined>
  platform?: string
  /** The running cli.js — tests only. */
  selfPath?: string
  /** The resolved core — tests only. */
  core?: ResolvedCore
  /** The self-activation outcome (r4-fixes A12) — tests only; doctor otherwise asks the store itself. */
  activation?: Activation
}

/** Why the per-user core is not active, in doctor's words (r4-fixes A12). */
function activationGap(a: Activation): string {
  if (a.status === 'failed') {
    return a.reason === 'mismatch'
      ? `the per-user copy was refused: ${a.detail}`
      : `the per-user copy could not be written (${a.detail}) — a read-only home or data dir keeps the stub`
  }
  if (a.status !== 'skipped') return ''
  switch (a.reason) {
    case 'no-digest':
      return 'this build carries no core digest, so it cannot activate one per user'
    case 'no-store':
      return 'no XDG_DATA_HOME or HOME to keep a per-user core in'
    default:
      return ''
  }
}

/**
 * Did sofar.sh's install script leave the JavaScript stub as its
 * bin/sofar-core (r4-fixes U9)? npm links that file onto PATH for the hook
 * shims, and postinstall swaps it for the platform binary (install.mjs). npm
 * 12 skips install scripts unless allowed, so the stub stays and node boots in
 * front of every hook. Null when this is not a global npm install — a source
 * checkout or a local dependency, where the advice does not apply.
 */
export function installedCoreIsStub(selfPath: string): boolean | null {
  if (planUpgrade(selfPath).kind !== 'global-npm') return null
  try {
    const shim = join(dirname(dirname(selfPath)), 'bin', 'sofar-core')
    return readFileSync(shim).subarray(0, 2).toString('latin1') === '#!'
  } catch {
    return null
  }
}

/** The hot-path line for a platform-package core: version skew, then where hooks find it. */
function packageCoreFinding(
  core: Extract<ResolvedCore, { kind: 'package' }>,
  env: Record<string, string | undefined>,
  platform: string,
  probe: CoreProbe,
): Finding {
  const named = `${CORE_PACKAGE}${core.version === null ? '' : ` ${core.version}`}`
  if (core.version !== null && core.version !== CURRENT_VERSION) {
    return {
      level: 'warn',
      text: `hot path: native core ${core.version} does not match sofar ${CURRENT_VERSION}`,
      hint: 'run `sofar upgrade` — the core ships pinned to each release',
    }
  }
  // Self-activation (r4-fixes A12): the boot stub already tried before this
  // ran; asking again is idempotent and names the outcome.
  const selfPath = probe.selfPath ?? fileURLToPath(import.meta.url)
  const activation =
    probe.activation ??
    activateCore({ version: CURRENT_VERSION, env, platform, from: import.meta.url, shim: join(dirname(dirname(selfPath)), 'bin', 'sofar-core') })
  if (activation.status === 'active' || activation.status === 'activated') {
    return { level: 'ok', text: `hot path: native core ${named}, activated for this user at ${activation.path}` }
  }
  // Windows keeps the stub by design: npm's .cmd wrapper runs it with node,
  // and the stub finds the .exe itself (install.mjs).
  if (platform !== 'win32' && installedCoreIsStub(selfPath) === true) {
    const gap = activationGap(activation)
    return {
      level: 'warn',
      text: `hot path: node boots before the native core on every hook — sofar.sh's install script did not run, so its \`sofar-core\` is still the JavaScript stub${gap === '' ? '' : `, and ${gap}`}`,
      hint: `npm 12 skips install scripts unless allowed: run \`${ALLOW_SCRIPTS_CONFIG}\`, then reinstall with \`${ALLOW_SCRIPTS_INSTALL}\``,
    }
  }
  return { level: 'ok', text: `hot path: native core ${named}` }
}

/**
 * Which implementation the hot path runs on (rust-core 3.2). Never a fault:
 * a source checkout or an unsupported platform has no core and every hook
 * still runs, on TypeScript. Two warnings: a version mismatch — a core that
 * is not this release's, which only an override or a hand install can
 * produce, since sofar.sh pins each platform package at its own version — and
 * a global install whose install script did not run, so node still boots in
 * front of the core on every hook (r4-fixes U9) — unless the core was
 * activated for this user (r4-fixes A12), which the line then names.
 */
export function auditCore(findings: Finding[], probe: CoreProbe = {}): void {
  const env = probe.env ?? process.env
  const platform = probe.platform ?? process.platform
  const core = probe.core ?? resolveCore(env.SOFAR_CORE, import.meta.url)
  switch (core.kind) {
    case 'override':
      findings.push({ level: 'ok', text: `hot path: native core named by SOFAR_CORE (${core.path})` })
      break
    case 'package':
      findings.push(packageCoreFinding(core, env, platform, probe))
      break
    default:
      findings.push({
        level: 'ok',
        text:
          core.reason === 'forbidden'
            ? 'hot path: TypeScript (SOFAR_CORE=0)'
            : `hot path: TypeScript (no native core installed for ${process.platform}-${process.arch})`,
      })
  }
}

// ---------------------------------------------------------------------------
// 2. Record health.
// ---------------------------------------------------------------------------

/** Below this many files, a session touching them without task changes is noise, not untracked work. */
const UNTRACKED_FILE_THRESHOLD = 3

/** Fold warnings listed per record before the `+N more` sentinel. */
const FOLD_WARNING_HINTS = 5

interface Folded {
  slug: string
  state?: InitiativeState
  warnings: string[]
  orphans: OrphanTaskEvent[]
  /** Session ids seen on events here but never registered here (2.1). */
  unregistered: string[]
  error?: string
}

function listInitiatives(rootDir: string): string[] {
  const dir = join(rootDir, '.sofar', 'initiatives')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** Fold every initiative with a log ONCE — record + concurrency checks share the result. */
function foldInitiatives(rootDir: string): Folded[] {
  return listInitiatives(rootDir)
    .filter((slug) => existsSync(join(rootDir, '.sofar', 'initiatives', slug, 'events.jsonl')))
    .map((slug) => {
      const logPath = join(rootDir, '.sofar', 'initiatives', slug, 'events.jsonl')
      try {
        const result = foldLog(logPath)
        return {
          slug,
          state: result.state,
          warnings: result.warnings,
          orphans: result.orphan_task_events,
          unregistered: result.unregistered_sessions,
        }
      } catch (err) {
        return { slug, warnings: [], orphans: [], unregistered: [], error: errMessage(err) }
      }
    })
}

/** Real (non-sentinel) file count from a session's derived activity. */
function realFileCount(files: string[]): number {
  return files.filter((f) => !f.startsWith('+')).length
}

function auditRecords(folded: Folded[]): Section {
  const findings: Finding[] = []
  if (folded.length === 0) {
    findings.push({ level: 'ok', text: 'no initiative logs yet — nothing to fold' })
    return { title: 'Record health', findings }
  }
  // Citation resolution needs the sibling slugs, so a cross-initiative
  // reference in a drop reason ("felt-cost D3") counts as cited.
  const knownSlugs = folded.map((f) => f.slug)

  for (const { slug, state, warnings, orphans, error } of folded) {
    if (error !== undefined || state === undefined) {
      findings.push({ level: 'fail', text: `${slug}: cannot read log — ${error ?? 'unknown error'}` })
      continue
    }
    const before = findings.length

    // Stub sessions (BD21): session_ended with no session_started.
    const stubs = state.sessions.filter((s) => s.tool === 'unknown').map((s) => s.id)
    if (stubs.length > 0) {
      findings.push({
        level: 'warn',
        text: `${slug}: ${stubs.length} stub session(s) — session_ended without session_started`,
        hint: `ids: ${stubs.join(', ')} (a hook or agent wrote back without registering the session)`,
      })
    }

    // Fold warnings (corrupt/unknown lines) — tolerated by design, surfaced here.
    // Listed rather than sampled: this showed `warnings[0]` alone, so in a
    // record carrying several, every warning after the first was invisible —
    // and a record that already has warnings is exactly where a NEW one most
    // needs to be read (plan-carry-forward Phase 3 review). Capped with the
    // usual `+N more` sentinel so one corrupt log cannot flood the report.
    if (warnings.length > 0) {
      const shown = warnings.slice(0, FOLD_WARNING_HINTS)
      const hidden = warnings.length - shown.length
      const hint = hidden > 0 ? [...shown, `+${hidden} more (see \`sofar status <slug>\`)`] : shown
      findings.push({
        level: 'warn',
        text: `${slug}: ${warnings.length} fold warning(s)`,
        hint: hint.join('\n'),
      })
    }

    // Stale phase (task 11.1): all tasks done but the phase never marked
    // done — detection extracted to core (staleness-detection 1.2) so the
    // status renders share it; the WARN text here is unchanged.
    for (const stale of staleActivePhases(state)) {
      findings.push({
        level: 'warn',
        text: `${slug}: phase "${stale.name}" — all ${stale.tasks_done} tasks done but phase still ${stale.status}`,
        hint: 'emit phase_status_changed to mark it done, else it keeps showing as the active phase',
      })
    }

    // Unexplained drop (task-drop-state 4.1): `dropped` closes a task without
    // delivering it, so the reason is the only record that a decision was made
    // at all. The tool refuses an empty note, but a log can predate that rule
    // or be written by hand — and a reason citing no decision leaves the
    // "why" wherever the author's context went. Cite-checked, not just present.
    for (const [taskId, note] of Object.entries(state.drop_notes)) {
      const cited = extractCitations(note, slug, knownSlugs).length > 0
      if (note.trim() === '') {
        findings.push({
          level: 'warn',
          text: `${slug}: task "${taskId}" dropped with no reason`,
          hint: 'a drop with no stated reason reads as forgotten rather than decided — re-emit task_status_changed with a note',
        })
      } else if (!cited) {
        findings.push({
          level: 'warn',
          text: `${slug}: task "${taskId}" dropped citing no decision`,
          hint: `reason recorded ("${note.slice(0, 60)}${note.length > 60 ? '…' : ''}") but it points at no D<n> — log the decision and cite it, so the drop survives the author's context`,
        })
      }
    }

    // Untracked work (task 11.3): a wrapped session that did real file work but
    // touched no plan task — its work is not reflected in the phase tree. Only
    // ended sessions (an open one may still add tasks); deterministic, so it
    // catches purely-untracked sessions, not mixed ones.
    for (const s of state.sessions) {
      if (s.ended === undefined || s.activity === undefined) continue
      if (realFileCount(s.activity.files) >= UNTRACKED_FILE_THRESHOLD && s.activity.task_changes.length === 0) {
        findings.push({
          level: 'warn',
          text: `${slug}: session ${s.id} touched ${realFileCount(s.activity.files)} files but changed no plan tasks`,
          hint: 'either the work is not tracked as tasks, or its tasks landed on a sibling session — adopt the hook session via start_session so files + task changes stay together',
        })
      }
    }

    // Misroute symptom (task 12.2, BD58): task_status_changed events whose id
    // the plan never absorbed — until now they only fold-warned generically.
    // A cluster of them usually means another initiative's task ids landed
    // here via a branch-switch misroute. One WARN per distinct orphan id.
    const byTask = new Map<string, OrphanTaskEvent[]>()
    for (const o of orphans) {
      const group = byTask.get(o.task_id) ?? []
      group.push(o)
      byTask.set(o.task_id, group)
    }
    for (const [taskId, group] of byTask) {
      const last = group[group.length - 1]!
      findings.push({
        level: 'warn',
        text: `${slug}: ${group.length} task event(s) for "${taskId}" — no such task in the plan`,
        hint: `possible misroute from another initiative (session ${last.session}, last event ${last.event_id}) — correct the event(s) or add the task`,
      })
    }

    if (findings.length === before) findings.push({ level: 'ok', text: `${slug}: folds clean` })
  }
  return { title: 'Record health', findings }
}

/** One session's footprint in one initiative (record-integrity 2.1). */
interface Footprint {
  slug: string
  registered: boolean
  /** Registered here and not yet ended — the split is still moving (3.2). */
  open: boolean
}

/**
 * Split sessions (record-integrity 2.1/2.2) — one session id with events in
 * more than one initiative. This is data corruption, not hygiene, so it
 * reports at FAIL: the session's work is torn across records and no single
 * fold can show it whole.
 *
 * Two shapes, both caught here:
 *  - TORN — registered (session_started) in ≥2 initiatives. Its MCP writes
 *    and its hook writes went to different logs.
 *  - LEAKED — events in an initiative that never registered it, so the fold
 *    attributes them to nobody while they still inflate that initiative's
 *    freshness counters and files_touched.
 *
 * Phase 1 stops new splits at the source (writes now follow the session home),
 * so severity grades by LIVENESS rather than shape (D3): a split whose
 * sessions have all ENDED is settled history — unrepairable by construction,
 * since no event carries a self-evident misplacement marker — and reports at
 * WARN so it stays visible without permanently failing the audit. A split
 * with a session still OPEN is a pre-fix session actively tearing right now,
 * and reports at FAIL. Deterministic: sessions sorted by id, footprints by
 * slug.
 */
/**
 * Initiative lifecycle (initiative-lifecycle 4.3) — the two ways a record's
 * status and its surroundings fall out of step.
 *
 * Both are the initiative-level mirror of checks that already exist one level
 * down: a stale ACTIVE phase whose tasks are all resolved, and a drop with no
 * stated reason. The same false signal reads worse up here — a whole record
 * that looks like live work when it is finished is what every orienting
 * surface then repeats.
 */
function auditLifecycle(rootDir: string, folded: Folded[]): Section {
  const findings: Finding[] = []

  let bindings: Record<string, unknown> = {}
  try {
    bindings = readBindingsFile(join(rootDir, '.sofar', 'bindings.json'))
  } catch {
    bindings = {} // malformed — auditWiring owns that finding, not this one
  }

  for (const { slug, state } of folded) {
    if (state === undefined) continue

    // Closing unbinds every branch, so a bound branch on a closed record means
    // something put it back: a hand-edit, or a merge that resurrected the
    // entry. Re-running close is the repair — it is idempotent by design.
    if (isClosedInitiativeStatus(state.status)) {
      const bound = Object.keys(bindings)
        .filter((branch) => bindings[branch] === slug)
        .sort()
      if (bound.length > 0) {
        findings.push({
          level: 'warn',
          text: `${slug}: closed (${state.status}) but still bound to ${bound.map((b) => `"${b}"`).join(', ')}`,
          hint: `a new session on that branch would land on finished work — re-run \`sofar close ${slug}\` (idempotent) or \`sofar switch ${slug}\` to reopen it`,
        })
      }
      // A successor is a pointer into the record layout, and the layout can
      // move under it: a rename, a deleted directory, a slug that never
      // existed on this checkout (initiative-supersession 3.2). Close checks
      // it at write time; this is the read-time check for everything after.
      if (state.successor !== null && !folded.some((f) => f.slug === state.successor)) {
        findings.push({
          level: 'warn',
          text: `${slug}: superseded by "${state.successor}", which does not exist under .sofar/initiatives/`,
          hint: `every surface points resumption at a record that is not there — re-close it naming the right one: \`sofar close ${slug} --superseded-by <slug>\``,
        })
      }
      continue
    }

    // Every phase resolved but the initiative never closed — the mirror of the
    // stale-phase axis, one level up. Nothing remains to do, yet the record
    // still counts as live everywhere: `sofar next` lists it, the statusline
    // shows it, and a fresh session resumes work that is over.
    if (state.phases.length > 0 && state.phases.every((p) => isResolvedTaskStatus(p.status))) {
      findings.push({
        level: 'warn',
        text: `${slug}: all ${state.phases.length} phase(s) resolved but the initiative is still active`,
        hint: `nothing remains, yet it still reads as live work everywhere — close it with \`sofar close ${slug}\``,
      })
    }
  }

  if (findings.length === 0) {
    findings.push({ level: 'ok', text: 'no closed initiative still bound, no finished record left open' })
  }
  return { title: 'Initiative lifecycle', findings }
}

function auditSplitSessions(folded: Folded[]): Section {
  const footprints = new Map<string, Footprint[]>()
  const add = (id: string, slug: string, registered: boolean, open = false): void => {
    if (id === 'cli') return
    const list = footprints.get(id) ?? []
    list.push({ slug, registered, open })
    footprints.set(id, list)
  }
  for (const { slug, state, unregistered } of folded) {
    if (state !== undefined) {
      for (const s of state.sessions) add(s.id, slug, true, s.ended === undefined)
    }
    for (const id of unregistered) add(id, slug, false)
  }

  const findings: Finding[] = []
  const split = [...footprints.entries()]
    .filter(([, list]) => list.length > 1)
    .sort(([a], [b]) => byCodeUnit(a, b))

  for (const [id, list] of split) {
    list.sort((a, b) => byCodeUnit(a.slug, b.slug))
    const homes = list.filter((f) => f.registered).map((f) => f.slug)
    const leaked = list.filter((f) => !f.registered).map((f) => f.slug)
    const shape = homes.length > 1 ? 'torn' : 'leaked'
    const live = list.some((f) => f.open)
    let hint: string
    if (homes.length > 1) {
      hint = `registered in ${homes.join(', ')} — its writes were split across ${homes.length} records`
    } else if (homes.length === 1) {
      hint = `registered in ${homes[0]!}; events also landed in ${leaked.join(', ')} where it is unknown`
    } else {
      hint = `registered nowhere; events landed in ${leaked.join(', ')} — no log claims this session`
    }
    hint += live
      ? ' — this session is still OPEN: end it before more events tear'
      : ' — settled history (all sessions ended); the write pin prevents new splits'
    findings.push({
      level: live ? 'fail' : 'warn',
      text: `session ${id} spans ${list.length} initiatives (${shape}${live ? ', live' : ', history'}): ${list.map((f) => f.slug).join(', ')}`,
      hint,
    })
  }

  if (findings.length === 0) {
    findings.push({ level: 'ok', text: 'no session spans more than one initiative' })
  }
  return { title: 'Session routing', findings }
}

/**
 * Decision guards (drift-hardening D3) — the retrospective half of the
 * mechanical tier. The hooks warn a session about its OWN crossings while it
 * works; this axis answers the other question, over the whole record: which
 * guarded rules has this initiative's work crossed, by whom, and where.
 *
 * WARN, never FAIL — a guard is advisory by construction (D3), and doctor's
 * exit code is the same exit code the rule says a violation must not move.
 * The rule text is reproduced VERBATIM (D2): this is a surface, so the
 * never-clip contract binds it exactly as it binds the digest.
 */
function auditGuards(rootDir: string, folded: Folded[]): Section {
  const findings: Finding[] = []
  let guarded = 0
  for (const { slug, state } of folded) {
    if (state === undefined) continue
    guarded += state.decisions.filter((d) => d.guard !== undefined).length
    for (const v of state.guard_violations) {
      const rel = relative(rootDir, v.subject)
      const where = v.domain === 'path' && rel.length > 0 && !rel.startsWith('..') ? rel : v.subject
      findings.push({
        level: 'warn',
        text: `${slug}: [D${v.decision}] guard crossed — ${where}`,
        hint: `"${v.rule}" (guard: ${v.guard}; session ${v.session}, event ${v.event_id})`,
      })
    }
  }
  if (findings.length === 0) {
    findings.push({
      level: 'ok',
      text:
        guarded === 0
          ? 'no decision carries a guard'
          : `no work crosses any of the ${guarded} guarded rule(s)`,
    })
  }
  const unapproved = unapprovedChecks(rootDir)
  if (unapproved.length > 0) findings.push(unapprovedFinding(unapproved))
  return { title: 'Decision guards', findings }
}

/** Checks in force that nothing approved on this clone; empty when the record cannot say. */
function unapprovedChecks(rootDir: string): InForceCheck[] {
  try {
    return checksInForce(refreshGuards(join(rootDir, '.sofar'))).filter((c) => !isApproved(rootDir, c.check.cmd))
  } catch {
    return []
  }
}

/**
 * Pre-commit and Stop name unapproved checks once per clone per day (r4-fixes
 * U7); doctor names them every time, since it is where the operator asks.
 */
function unapprovedFinding(checks: readonly InForceCheck[]): Finding {
  const named = checks.slice(0, 3).map((c) => `[${c.handle}] \`${c.check.cmd}\``).join(', ')
  const more = checks.length > 3 ? `, +${checks.length - 3} more` : ''
  return {
    level: 'warn',
    text: `${checks.length} decision check(s) not approved on this clone, so none of them runs at Stop or pre-commit: ${named}${more}`,
    hint: 'the operator approves one with `sofar check --approve "<handle>"`; `sofar check --list` shows them all',
  }
}

function auditConcurrency(folded: Folded[]): Section {
  const findings: Finding[] = []
  let conflictTotal = 0
  for (const { slug, state } of folded) {
    if (state === undefined) continue
    for (const c of openSessionFileConflicts(state)) {
      conflictTotal++
      findings.push({
        level: 'warn',
        text: `${slug}: ${c.path} — touched by ${c.sessions.length} open sessions`,
        hint: `sessions ${c.sessions.join(', ')} are both in-flight on this file (concurrent-edit / clobber risk)`,
      })
    }
  }
  // The boundary the per-slug loop above cannot see (cross-initiative-conflicts
  // 3.1). A clobber is physical: two agents in one file overwrite each other
  // whether or not they serve the same record, and until now NOTHING reported
  // that — the hook folds a single slug, and the loop above detects per-slug.
  //
  // Ungated here on purpose. core/graph.ts's law is that cross-record
  // derivations stay off the hot path because a shim can afford one log where
  // this reads N; doctor is the other side of that bargain — an audit, run on
  // demand, where the exhaustive answer is the whole point and milliseconds
  // are not. So however narrow the live surfaces are, the complete answer
  // always exists behind one command.
  const states = folded.filter((f): f is Folded & { state: InitiativeState } => f.state !== undefined)
  const crossed = crossConflictsFromStates(states)
  for (const c of crossed) {
    conflictTotal++
    findings.push({
      level: 'warn',
      text: `${c.path} — held across ${c.initiatives.length} initiatives (${c.initiatives.join(', ')})`,
      hint: `${c.holders.map((h) => `${h.session} in ${h.initiative}`).join('; ')} — a clobber does not respect the initiative boundary`,
    })
  }

  if (conflictTotal === 0) {
    findings.push({ level: 'ok', text: 'no files under concurrent edit by multiple open sessions' })
  }
  return { title: 'Concurrency', findings }
}

// ---------------------------------------------------------------------------
// 3. Repo memory — repo-general decisions absent from .sofar/repo.md.
// ---------------------------------------------------------------------------

/**
 * Repo-generality is OBSERVED, not declared (record-graph 2.3): a decision
 * cited FROM initiatives other than its own is repo-general by behaviour.
 * Such a decision is repo-wide law that a new session only meets if the
 * hand-written repo.md — the one file every SessionStart injects — names it.
 *
 * DETECTION ONLY. repo.md is hand-written per SPEC §Record layout, and sofar
 * never generates or rewrites it; both the curation and the SessionStart
 * token budget are the author's. So this reports and stops at WARN.
 *
 * "Names it" is literal, and deliberately the record's OWN citation grammar:
 * a QUALIFIED handle, `<slug> D<n>`. Prose matching would be inference (D3)
 * and would go stale the moment either text is reworded; the qualified handle
 * is stable, greppable, and the same form the decisions cite each other by.
 * Unqualified `D<n>` cannot count — repo.md has no home initiative, so the
 * handle would be ambiguous across every log in the repo.
 */
function auditRepoMemory(rootDir: string, folded: Folded[]): Section {
  const findings: Finding[] = []
  const graph = buildGraph(rootDir)
  const general = repoGeneral(graph)
  // The DECLARED half (repo-memory-capture D1): operational knowledge whose
  // repo-wide scope its author knew at capture time. Observation cannot reach
  // it — a fact that was never written down produces no citation behaviour to
  // read — so promotion is what puts it in front of this axis at all.
  // A superseded memory (r1-fixes D8) is retired: its successor is what
  // repo.md should name, so the old handle stops being reported. Resolved
  // across every folded record here, since a supersession may cross records.
  // A stamped one (memory-lead 2.8, D12) is resolved by id: its `M<n>` moves
  // when a merge renumbers the target record, and the id never does.
  const handleOf = new Map(
    folded.flatMap(({ slug, state }) => (state?.memories ?? []).map((memory, index) => [memory.id, `${slug} M${index + 1}`] as const)),
  )
  const retired = new Set(
    folded.flatMap(({ state }) =>
      (state?.memories ?? []).flatMap((memory) => {
        if (memory.supersedes_id !== undefined) {
          const handle = handleOf.get(memory.supersedes_id)
          return handle !== undefined ? [handle] : []
        }
        return memory.supersedes !== undefined ? [memory.supersedes] : []
      }),
    ),
  )
  const promoted = folded.flatMap(({ slug, state }) =>
    (state?.memories ?? [])
      .map((memory, index) => ({
        slug,
        ordinal: index + 1,
        text: memory.text,
      }))
      .filter((memory) => !retired.has(`${memory.slug} M${memory.ordinal}`)),
  )

  if (general.length === 0 && promoted.length === 0) {
    findings.push({
      level: 'ok',
      text: 'nothing observed as repo-general and nothing promoted (no decision cited from outside its own initiative, no memory_promoted events)',
    })
    return { title: 'Repo memory', findings }
  }

  const repoMd = join(rootDir, '.sofar', 'repo.md')
  let prose = ''
  try {
    prose = readFileSync(repoMd, 'utf8')
  } catch {
    // Missing or unreadable repo.md names nothing — every finding below fires,
    // which is the honest answer (init writes the stub; a deleted one is a gap).
  }
  const named = new Set(
    extractCitations(prose, '', listInitiatives(rootDir), { memories: true })
      .filter((c) => c.qualified)
      .map((c) => `${c.slug} ${c.handle}`),
  )

  for (const decision of general) {
    const handle = `${decision.initiative} D${decision.ordinal}`
    if (named.has(handle)) continue
    findings.push({
      level: 'warn',
      text: `${handle} is repo-general — cited from ${decision.cited_by.join(', ')} — but .sofar/repo.md never names it`,
      hint: `chose: ${clip(decision.chose, 120)} — write it into repo.md by hand, citing \`${handle}\` (sofar never generates repo.md)`,
    })
  }
  for (const memory of promoted) {
    const handle = `${memory.slug} M${memory.ordinal}`
    if (named.has(handle)) continue
    findings.push({
      level: 'warn',
      text: `${handle} was promoted to repo memory but .sofar/repo.md never names it`,
      hint: `${clip(memory.text, 120)} — write it into repo.md by hand, citing \`${handle}\` (sofar never generates repo.md)`,
    })
  }
  if (findings.length === 0) {
    const parts: string[] = []
    if (general.length > 0) {
      parts.push(`${general.length} repo-general decision${general.length === 1 ? '' : 's'}`)
    }
    if (promoted.length > 0) {
      parts.push(`${promoted.length} promoted ${promoted.length === 1 ? 'memory' : 'memories'}`)
    }
    findings.push({ level: 'ok', text: `all ${parts.join(' and ')} named in .sofar/repo.md` })
  }
  return { title: 'Repo memory', findings }
}

// ---------------------------------------------------------------------------
// 4. Scanner hazards (+ --fix).
// ---------------------------------------------------------------------------

interface ScanProgress {
  caps: Caps
  stream?: SpinnerStream
}

/**
 * The tree walk is doctor's one genuinely long step (every other check is a
 * handful of stats/reads), so the scan spinner wraps exactly this — and ONLY
 * when stderr can animate (a real TTY): piped/CI runs must stay byte-identical
 * to the unstyled command, so the spinner kernel's static-line fallback is
 * skipped too (the same policy as the upgrade spinner).
 */
function scanEntries(rootDir: string, progress: ScanProgress): string[] {
  if (!progress.caps.animate) return findTailwindCssEntries(rootDir)
  const spinner = createSpinner({
    caps: progress.caps,
    text: 'scanning tree for Tailwind entry stylesheets',
    useCase: 'scan',
    ...(progress.stream !== undefined ? { stream: progress.stream } : {}),
  }).start()
  let entries: string[]
  try {
    entries = findTailwindCssEntries(rootDir)
  } catch (err) {
    spinner.fail(`tree scan failed — ${errMessage(err)}`)
    throw err
  }
  spinner.succeed(
    `tree scan: ${entries.length} Tailwind entry stylesheet${entries.length === 1 ? '' : 's'}`,
  )
  return entries
}

/**
 * Why `--fix` is withheld, and what to do instead. `@source not` landed in
 * Tailwind 4.1; on 4.0.x it parses as an unquoted path and breaks the build,
 * so the hazard is still reported but the write never happens (scanner-version-gate D1). The
 * escape hatch we name works on 4.0: narrowing the import's scan base.
 */
function sourceNotUnavailableHint(
  tw: TailwindV4Detection,
  cssFile: string,
  rootDir: string,
): string {
  const found =
    tw.installed !== undefined
      ? `tailwindcss ${tw.installed} installed`
      : `tailwindcss ${tw.range} declared, not installed — resolved version unknown`
  return `${found}; \`@source not\` needs >= ${SOURCE_NOT_SINCE}, so --fix would break your build — upgrade tailwindcss and rerun, or narrow the scan base by hand: \`${sofarScanBaseDirective(cssFile, rootDir)}\` (relative to this stylesheet; templates outside it stop being scanned)`
}

function auditScanners(rootDir: string, fix: boolean, progress: ScanProgress, writes: WiringFile[] = []): Section {
  const findings: Finding[] = []
  const tw = detectTailwindV4(rootDir)
  if (!tw.v4) {
    findings.push({ level: 'ok', text: 'no tree-wide class scanner detected (Tailwind v4 absent)' })
    return { title: 'Scanner hazards', findings }
  }

  const entries = scanEntries(rootDir, progress)
  if (entries.length === 0) {
    findings.push({
      level: 'warn',
      text: `Tailwind v4 present (tailwindcss ${tw.range}) but no \`@import "tailwindcss"\` entry stylesheet found`,
      hint: 'if you add one, run `sofar doctor --fix` to exclude .sofar from scanning',
    })
    return { title: 'Scanner hazards', findings }
  }

  for (const entry of entries) {
    const rel = relative(rootDir, entry)
    let content: string
    try {
      content = readFileSync(entry, 'utf8')
    } catch (err) {
      findings.push({ level: 'fail', text: `${rel}: cannot read — ${errMessage(err)}` })
      continue
    }
    if (cssExcludesSofar(content, entry, rootDir)) {
      findings.push({ level: 'ok', text: `${rel}: excludes .sofar from Tailwind scanning` })
      continue
    }
    if (fix && tw.sourceNot) {
      const { content: next, changed } = insertSofarExclusion(content, entry, rootDir)
      if (changed) {
        try {
          writeFileSync(entry, next, 'utf8')
          writes.push({ path: entry, op: 'write', sha256: sha256Hex(next) })
        } catch (err) {
          findings.push({ level: 'fail', text: `${rel}: fix failed — ${errMessage(err)}` })
          continue
        }
        findings.push({
          level: 'ok',
          text: `${rel}: added \`${sofarExclusionDirective(entry, rootDir)}\``,
          fixed: true,
        })
        continue
      }
    }
    findings.push({
      level: 'fail',
      text: `${rel}: Tailwind v4 will scan .sofar/ — no \`@source not\` exclusion`,
      hint: !tw.sourceNot
        ? sourceNotUnavailableHint(tw, entry, rootDir)
        : fix
          ? 'could not place the exclusion (no `@import "tailwindcss"` line to anchor on)'
          : `fix: sofar doctor --fix   (or add \`${sofarExclusionDirective(entry, rootDir)}\` after the import)`,
    })
  }
  return { title: 'Scanner hazards', findings }
}

// ---------------------------------------------------------------------------
// 5. Formatter hazards (+ --fix) — r1-fixes 1.4, r1-fixes D7.
// ---------------------------------------------------------------------------

/**
 * Biome, Prettier and markdownlint each process the whole tree by default,
 * so a committed `.sofar/` — generated markdown and JSON nobody hand-edits —
 * turns their checks red and sends the agent off to patch the tool's config
 * (round 1: 3/7 runs). Same defence as the scanner axis (D-P10): configure
 * the tool away from `.sofar` with the one exclusion it documents, never
 * touch the record. Writes are withheld, with the exact line named, when the
 * config cannot be round-tripped (comments) or Biome's dialect is unknown.
 */
function auditFormatters(rootDir: string, fix: boolean, writes: WiringFile[] = []): Section {
  const findings: Finding[] = []
  const hazards = detectFormatterHazards(rootDir)
  if (hazards.length === 0) {
    findings.push({
      level: 'ok',
      text: 'no formatter or linter reaching .sofar detected (Biome, Prettier, markdownlint absent)',
    })
    return { title: 'Formatter hazards', findings }
  }
  for (const h of hazards) {
    if (h.excluded) {
      findings.push({ level: 'ok', text: `${h.label}: excludes .sofar (${h.file})` })
      continue
    }
    if (fix && h.apply !== undefined) {
      try {
        h.apply()
        const file = join(rootDir, h.file)
        writes.push({ path: file, op: 'write', sha256: sha256Hex(readFileSync(file, 'utf8')) })
      } catch (err) {
        findings.push({ level: 'fail', text: `${h.label}: fix failed — ${errMessage(err)}` })
        continue
      }
      findings.push({ level: 'ok', text: `${h.label}: added ${h.directive} to ${h.file}`, fixed: true })
      continue
    }
    findings.push({
      level: 'fail',
      text: `${h.label} will process .sofar/ — no exclusion in ${h.file}`,
      hint: h.withheld !== undefined
        ? `${h.withheld}: ${h.directive}`
        : `fix: sofar doctor --fix   (or add ${h.directive} to ${h.file})`,
    })
  }
  return { title: 'Formatter hazards', findings }
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

interface Tally {
  fails: number
  warns: number
  fixesApplied: number
}

function tallyOf(sections: Section[]): Tally {
  const tally: Tally = { fails: 0, warns: 0, fixesApplied: 0 }
  for (const section of sections) {
    for (const f of section.findings) {
      if (f.level === 'fail') tally.fails++
      if (f.level === 'warn') tally.warns++
      if (f.fixed === true) tally.fixesApplied++
    }
  }
  return tally
}

/** Summary fragments, each count colored by its own severity (identity when plain). */
function summaryParts(tally: Tally, style: Style): string[] {
  const parts: string[] = []
  if (tally.fixesApplied > 0) {
    parts.push(style.success(`${tally.fixesApplied} fix${tally.fixesApplied === 1 ? '' : 'es'} applied`))
  }
  parts.push(
    tally.fails === 0
      ? style.success('no problems found')
      : style.error(`${tally.fails} problem${tally.fails === 1 ? '' : 's'} found`),
  )
  if (tally.warns > 0) parts.push(style.warn(`${tally.warns} warning${tally.warns === 1 ? '' : 's'}`))
  return parts
}

/** The pre-cli-ui plain report — the piped/NO_COLOR contract, byte-stable. */
function renderPlain(rootDir: string, sections: Section[], tally: Tally): string {
  const lines: string[] = [`sofar doctor — ${rootDir}`, '']
  for (const section of sections) {
    lines.push(`${section.title}:`)
    for (const f of section.findings) {
      lines.push(`${MARKER[f.level]}  ${f.text}`)
      // A hint may carry several lines (fold warnings list one per line);
      // each is indented identically, so a one-line hint is unchanged.
      if (f.hint !== undefined) for (const h of f.hint.split('\n')) lines.push(`          ${h}`)
    }
    lines.push('')
  }
  lines.push(`sofar doctor: ${summaryParts(tally, createStyle(false)).join(', ')}`)
  return `${lines.join('\n')}\n`
}

/** Styled report (cli-ui 2.4): ✓/⚠/✗ level marks, bold sections, dim └ hints. */
function renderStyled(rootDir: string, sections: Section[], tally: Tally, caps: Caps): string {
  const style = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const mark: Record<Level, string> = {
    ok: style.success(sym.ok),
    warn: style.warn(sym.warn),
    fail: style.error(sym.fail),
  }
  // ASCII fallback marks are uneven (√ / !! / ×) — pad so finding texts stay columnar.
  const markWidth = Math.max(...[sym.ok, sym.warn, sym.fail].map((s) => visibleWidth(s)))
  const lines: string[] = [`${style.bold('sofar doctor')} ${style.dim(`— ${rootDir}`)}`, '']
  for (const section of sections) {
    lines.push(style.bold(`${section.title}:`))
    for (const f of section.findings) {
      lines.push(`  ${padEndVisible(mark[f.level], markWidth)} ${f.text}`)
      if (f.hint !== undefined) {
        // Multi-line hints: the elbow marks the first line only, continuations
        // align under it, so the block reads as one hint rather than several.
        const pad = ' '.repeat(markWidth + 3)
        const cont = ' '.repeat(visibleWidth(sym.elbow) + 1)
        f.hint.split('\n').forEach((h, i) => {
          lines.push(style.dim(i === 0 ? `${pad}${sym.elbow} ${h}` : `${pad}${cont}${h}`))
        })
      }
    }
    lines.push('')
  }
  lines.push(style.bold(`sofar doctor: ${summaryParts(tally, style).join(', ')}`))
  return `${lines.join('\n')}\n`
}

export function runDoctor(
  rootDir: string,
  options: DoctorOptions = {},
  caps: Caps = stdoutCaps(),
  progress: DoctorProgress = {},
): CmdResult {
  const fix = options.fix === true
  if (!existsSync(join(rootDir, '.sofar'))) {
    return fail('sofar doctor: no .sofar/ record here — run `sofar init` first')
  }

  const folded = foldInitiatives(rootDir)
  const writes: WiringFile[] = []
  const sections = [
    auditWiring(rootDir, options.home, options.journal?.env),
    auditRecords(folded),
    auditLifecycle(rootDir, folded),
    auditSplitSessions(folded),
    auditConcurrency(folded),
    auditGuards(rootDir, folded),
    auditRepoMemory(rootDir, folded),
    auditScanners(rootDir, fix, { caps: progress.caps ?? stderrCaps(), stream: progress.stream }, writes),
    auditFormatters(rootDir, fix, writes),
  ]
  // `doctor --fix` writes outside .sofar/, so it is journaled like init (r4-fixes A11).
  const j = options.journal
  if (j !== undefined && writes.length > 0) {
    appendWiringEntry(
      rootDir,
      {
        ts: (j.now ?? (() => new Date().toISOString()))(),
        sofar: CURRENT_VERSION,
        root: rootDir,
        cwd: j.cwd,
        argv: [...j.argv],
        tty: j.tty,
        command: 'doctor --fix',
        agents: wiredAgents(rootDir),
        result: 'ok',
        files: writes.map((w) => ({ ...w, path: journalPath(rootDir, w.path) })),
      },
      j.env,
    )
  }

  const tally = tallyOf(sections)
  const stdout = caps.color
    ? renderStyled(rootDir, sections, tally, caps)
    : renderPlain(rootDir, sections, tally)
  return tally.fails === 0 ? ok(stdout) : { exitCode: 1, stdout, stderr: '' }
}
