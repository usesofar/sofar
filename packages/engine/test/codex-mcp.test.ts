import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_CONFIG,
  CODEX_DEFAULT_TOOLS,
  CODEX_DIRECT_KEY,
  CODEX_DIRECT_TABLE,
  CODEX_MCP_ADD,
  CODEX_MCP_TABLE,
  CODEX_TOOLS_APPROVAL,
  codexDirectState,
  codexMcpState,
  codexMcpTable,
  parseCodexTools,
  codexSofarToolsApprovalSet,
  codexUserConfigPath,
  withoutSofarDirect,
  withoutSofarServer,
  withSofarDirect,
  withSofarServer,
  withSofarTable,
} from '../src/cli/codex-config'
import { TOOL_NAMES } from '@sofar/schema/tool-inputs'

/** The table a default init writes (r4-fixes A2): only the write-back listed. */
const DEFAULT_TABLE = codexMcpTable(CODEX_DEFAULT_TOOLS)
import { runDoctor } from '../src/cli/doctor'
import { CODEX_MCP_USER_STEP_HINT, CODEX_TRUST_HINT, runInit, wiredAgents } from '../src/cli/init'
import { runUninit } from '../src/cli/uninit'
import { mcpRegistration } from '../src/mcp/register'
import { CONTRACT, type Obj } from './helpers/codex'

/**
 * Codex's MCP registration (agents-parity 2.2, D7). Codex reads no .mcp.json:
 * sofar's server goes in the project's .codex/config.toml as a
 * `[mcp_servers.sofar]` table, found and cut out by a structure-only scanner
 * (no TOML dependency). The table is held to what codex-cli 0.154.0's binary
 * names (fixtures/codex/contract, D4); the user-level fallback is
 * `codex mcp add`.
 */

const plain = { color: false, unicode: true, animate: false }
const roots: string[] = []
const mcp = CONTRACT.mcp as Obj

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function freshRepo(config?: string): string {
  const root = tempDir('sofar-codex-mcp-')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  if (config !== undefined) {
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, CODEX_CONFIG), config)
  }
  return root
}

/** A machine with no Codex user config, or one whose user config holds `config`. */
function home(root: string, config?: string): string {
  const dir = join(root, 'home')
  if (config !== undefined) {
    mkdirSync(join(dir, '.codex'), { recursive: true })
    writeFileSync(join(dir, '.codex', 'config.toml'), config)
  }
  return dir
}

function init(root: string) {
  return runInit(root, { agents: ['codex'], home: home(root) }, plain, plain)
}

function config(root: string): string {
  return readFileSync(join(root, CODEX_CONFIG), 'utf8')
}

describe('the table init writes', () => {
  it('names the server where codex 0.154.0 reads it, with keys its RawMcpServerConfig has', () => {
    expect(CODEX_CONFIG).toBe(mcp.project_file)
    expect(mcp.project_file_requires_trust).toBe(true)
    const [header, ...pairs] = CODEX_MCP_TABLE.trimEnd().split('\n')
    expect(header).toBe(`[${mcp.table as string}.sofar]`)
    const keys = pairs.map((line) => line.split(' = ')[0])
    expect(keys).toEqual(['command', 'args', 'default_tools_approval_mode'])
    for (const key of keys) expect(mcp.server_struct_fields_seen).toContain(key)
    expect(mcp.tools_approval_modes).toContain('approve')
  })

  it('registers the same server as .mcp.json, and the user-level step runs the same command', () => {
    const { command, args } = mcpRegistration().mcpServers.sofar
    expect(CODEX_MCP_TABLE).toBe(
      `[mcp_servers.sofar]\ncommand = "${command}"\nargs = [${args.map((a) => `"${a}"`).join(', ')}]\n${CODEX_TOOLS_APPROVAL}\n`,
    )
    expect(CODEX_TOOLS_APPROVAL).toBe('default_tools_approval_mode = "approve"')
    expect(CODEX_MCP_ADD).toBe(`codex mcp add sofar -- ${[command, ...args].join(' ')}`)
    expect((mcp.cli_add as string).split('<NAME>')[0]).toBe('codex mcp add ')
  })
})

describe('the tools Codex lists (r4-fixes A2)', () => {
  it('keeps only the write-back by default, with keys a Codex server table takes', () => {
    const [header, ...pairs] = DEFAULT_TABLE.trimEnd().split('\n')
    expect(header).toBe('[mcp_servers.sofar]')
    const keys = pairs.map((line) => line.split(' = ')[0])
    expect(keys).toEqual(['command', 'args', 'default_tools_approval_mode', 'enabled_tools', 'env'])
    // `env` is in the 0.154.0 contract; `enabled_tools` (with `enabled` and
    // `disabled_tools`) is read from the codex 0.136.0 binary's
    // RawMcpServerConfig strings, and R4-RESEARCH lane 1.2 (section 2.2) cites it for 0.160.0.
    for (const key of keys.filter((k) => k !== 'enabled_tools')) expect(mcp.server_struct_fields_seen).toContain(key)
    expect(DEFAULT_TABLE).toContain('enabled_tools = ["sofar_end_session"]\nenv = { SOFAR_MCP_TOOLS = "sofar_end_session" }\n')
    expect(codexMcpTable([])).toContain('enabled_tools = []\n')
  })

  it('parses --codex-tools, and refuses a tool sofar does not have', () => {
    expect(parseCodexTools(undefined, TOOL_NAMES)).toEqual(['sofar_end_session'])
    expect(parseCodexTools('all', TOOL_NAMES)).toBeNull()
    expect(parseCodexTools('none', TOOL_NAMES)).toEqual([])
    expect(parseCodexTools('end_session,log_decision', TOOL_NAMES)).toEqual(['sofar_end_session', 'sofar_log_decision'])
    expect(parseCodexTools('sofar_nope', TOOL_NAMES)).toHaveProperty('error')
  })

  it("swaps only sofar's own whole table, never a user's", () => {
    expect(withSofarTable(`a = 1\n\n${CODEX_MCP_TABLE}`, DEFAULT_TABLE)).toBe(`a = 1\n\n${DEFAULT_TABLE}`)
    expect(withSofarTable(`${DEFAULT_TABLE}\n[x]\ny = 2\n`, CODEX_MCP_TABLE)).toBe(`${CODEX_MCP_TABLE}\n[x]\ny = 2\n`)
    expect(withSofarTable(DEFAULT_TABLE, DEFAULT_TABLE)).toBeNull()
    // A key the user added under 0.34's table: the table is no longer sofar's alone.
    expect(withSofarTable(`${CODEX_MCP_TABLE}startup_timeout_sec = 20\n`, DEFAULT_TABLE)).toBeNull()
  })

  it('init --codex-tools all writes the 0.34 table, and SOFAR_PAYLOAD=v034 does too', () => {
    const all = freshRepo()
    expect(runInit(all, { agents: ['codex'], codexTools: null, home: home(all) }, plain, plain).exitCode).toBe(0)
    expect(config(all).startsWith(CODEX_MCP_TABLE)).toBe(true)
    expect(config(all)).not.toContain('enabled_tools')
    const legacy = freshRepo()
    runInit(legacy, { agents: ['codex'], env: { SOFAR_PAYLOAD: 'v034' }, home: home(legacy) }, plain, plain)
    expect(config(legacy)).not.toContain('enabled_tools')
  })
})

describe('whether sofar’s tools are pre-approved (3.4)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['the table init writes', CODEX_MCP_TABLE, true],
    ['an older table without the key', '[mcp_servers.sofar]\ncommand = "sofar"\nargs = ["mcp"]\n', false],
    ['the user’s own mode, which wins', '[mcp_servers.sofar]\ncommand = "sofar"\ndefault_tools_approval_mode = "prompt"\n', true],
    ['a dotted key', 'mcp_servers.sofar.default_tools_approval_mode = "approve"\n', true],
    ['an inline table', 'mcp_servers.sofar = { command = "sofar", default_tools_approval_mode = "approve" }\n', true],
    ['another server’s key', '[mcp_servers.docs]\ndefault_tools_approval_mode = "approve"\n[mcp_servers.sofar]\ncommand = "sofar"\n', false],
    ['a per-tool table only', '[mcp_servers.sofar]\ncommand = "sofar"\n[mcp_servers.sofar.tools.sofar_get_state]\napproval_mode = "approve"\n', false],
    ['an unreadable file', '[mcp_servers.sofar\n', false],
  ]
  it.each(cases)('%s', (_, text, expected) => {
    expect(codexSofarToolsApprovalSet(text)).toBe(expected)
  })
})

describe('reading a config.toml’s structure', () => {
  const cases: Array<[string, string, ReturnType<typeof codexMcpState>]> = [
    ['an empty file', '', 'absent'],
    ['settings only', 'model = "o3"\napproval_policy = "on-request"\n', 'absent'],
    ['another server’s table', '[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs"]\n', 'absent'],
    ['an [mcp_servers] table of inline servers', '[mcp_servers]\ndocs = { command = "npx" }\n', 'absent'],
    ['CRLF line endings', '[mcp_servers.docs]\r\ncommand = "npx"\r\n', 'absent'],
    ['comments that look like tables', '# [mcp_servers.sofar]\nmodel = "o3" # [mcp_servers.sofar]\n', 'absent'],
    ['a table inside a multi-line string', 'notes = """\n[mcp_servers.sofar]\n"""\n', 'absent'],
    ['a table inside a literal multi-line string', "notes = '''\n[mcp_servers.sofar]\n'''\n", 'absent'],
    ['an escaped quote before a table name', 'a = "say \\"[mcp_servers.sofar]\\""\n', 'absent'],
    ['a table name in a literal string', "a = '[mcp_servers.sofar]'\n", 'absent'],
    ['arrays of arrays across lines', 'matrix = [\n  [1, 2],\n  [3, 4], # row\n]\n', 'absent'],
    ['a local date-time', 'when = 1979-05-27 07:32:00Z\n', 'absent'],
    ['mcp_servers under another table', '[profiles.fast]\nmcp_servers = {}\n', 'absent'],
    ['sofar’s table', '[mcp_servers.sofar]\ncommand = "npx"\n', 'registered'],
    ['a quoted name', '[mcp_servers."sofar"]\n', 'registered'],
    ['an escaped name', '[mcp_servers."sof\\u0061r"]\n', 'registered'],
    ['a spaced sub-table', '[ mcp_servers . sofar . env ]\nX = "1"\n', 'registered'],
    ['an inline server under [mcp_servers]', '[mcp_servers]\nsofar = { command = "sofar" }\n', 'registered'],
    ['dotted keys', 'mcp_servers.sofar.command = "sofar"\n', 'registered'],
    ['an inline mcp_servers', 'mcp_servers = { sofar = { command = "sofar" } }\n', 'registered'],
    ['an inline mcp_servers without sofar', 'mcp_servers = { docs = { command = "npx" } }\n', 'blocked'],
    ['dotted mcp_servers keys without sofar', 'mcp_servers.docs.command = "npx"\n', 'blocked'],
    ['an array of mcp_servers tables', '[[mcp_servers]]\nname = "docs"\n', 'blocked'],
    ['an unterminated string', 'a = "open\n', 'unreadable'],
    ['an unclosed header', '[mcp_servers.sofar\n', 'unreadable'],
    ['a pair with no key', '= 1\n', 'unreadable'],
    ['an unclosed multi-line string', 'notes = """\nnever closed\n', 'unreadable'],
  ]
  it.each(cases)('%s', (_name, text, state) => {
    expect(codexMcpState(text)).toBe(state)
  })

  it('appends a table the scanner then reads as registered, keeping every byte before it', () => {
    for (const text of ['', 'model = "o3"\n', 'model = "o3"', '[projects."/repo"]\r\ntrust_level = "trusted"\r\n']) {
      const merged = withSofarServer(text)
      expect(merged.startsWith(text)).toBe(true)
      expect(codexMcpState(merged)).toBe('registered')
    }
    expect(withSofarServer('model = "o3"\n')).toBe(`model = "o3"\n\n${CODEX_MCP_TABLE}`)
  })

  it('removes sofar’s tables and sub-tables with one seam line, keeping what follows them', () => {
    const text = [
      'model = "o3"',
      '',
      '[mcp_servers.sofar]',
      'command = "npx" # mine',
      '',
      'args = ["sofar.sh", "mcp"]',
      '# about docs',
      '[mcp_servers.docs]',
      'command = "npx"',
      '',
      '[mcp_servers.sofar.env]',
      'SOFAR_X = "1"',
      '',
    ].join('\n')
    expect(withoutSofarServer(text)).toBe('model = "o3"\n# about docs\n[mcp_servers.docs]\ncommand = "npx"\n')
    expect(withoutSofarServer('a = "open\n')).toBeNull()
    expect(withoutSofarServer('[mcp_servers]\nsofar = { command = "sofar" }\n')).toBe(
      '[mcp_servers]\nsofar = { command = "sofar" }\n',
    )
  })
})

describe('sofar init --agents codex and .codex/config.toml', () => {
  it('creates the file with the table, says the project needs trusting, and is idempotent', () => {
    const root = freshRepo()
    const result = init(root)
    expect(result.stdout).toContain('created .codex/config.toml')
    expect(result.stdout).toContain(CODEX_TRUST_HINT)
    expect(result.stdout).not.toContain(CODEX_MCP_USER_STEP_HINT)
    expect(config(root)).toBe(`${DEFAULT_TABLE}\n${CODEX_DIRECT_TABLE}`)

    const again = init(root)
    expect(again.stdout).toContain('unchanged .codex/config.toml')
    expect(again.stdout).toContain('already initialized')
    expect(again.stdout).not.toContain(CODEX_TRUST_HINT)
  })

  it('appends after the user’s own config, and uninit gives the file back byte for byte', () => {
    const mine = [
      '# my Codex settings',
      'model = "o3"',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = [',
      '  "-y",',
      '  "docs-mcp", # pinned',
      ']',
      '',
      '[projects."/somewhere"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')
    const root = freshRepo(mine)
    const result = init(root)
    expect(result.stdout).toContain('updated .codex/config.toml')
    expect(result.stdout).toContain(CODEX_TRUST_HINT) // hooks.json is new too, but the note is the same
    expect(config(root)).toBe(`${mine}\n${DEFAULT_TABLE}\n${CODEX_DIRECT_TABLE}`)

    expect(runUninit(root, { purge: true }, plain, plain).exitCode).toBe(0)
    expect(config(root)).toBe(mine)
  })

  it('names the trust note when only the server is new', () => {
    const root = freshRepo()
    init(root)
    writeFileSync(join(root, CODEX_CONFIG), 'model = "o3"\n')
    const result = init(root)
    expect(result.stdout).toContain('unchanged .codex/hooks.json')
    expect(result.stdout).toContain('updated .codex/config.toml')
    expect(result.stdout).toContain(CODEX_TRUST_HINT)
  })

  it('keeps the user’s own sofar server, and uninit removes it as it removes .mcp.json’s', () => {
    const mine = '[mcp_servers.sofar]\ncommand = "npx"\nargs = ["sofar.sh", "mcp"]\n\n[projects."/x"]\ntrust_level = "trusted"\n'
    const root = freshRepo(mine)
    const result = init(root)
    expect(result.stdout).toContain('unchanged .codex/config.toml')
    expect(result.stdout).toContain("updated .codex/config.toml (Codex calls sofar's tools directly)")
    expect(config(root)).toBe(`${mine}\n${CODEX_DIRECT_TABLE}`)
    runUninit(root, {}, plain, plain)
    expect(config(root)).toBe('\n[projects."/x"]\ntrust_level = "trusted"\n')
  })

  it('leaves a file whose mcp_servers a table would clash with, and states the one user-level step', () => {
    const mine = 'mcp_servers = { docs = { command = "npx" } }\n'
    const root = freshRepo(mine)
    const result = init(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'skipped .codex/config.toml (its mcp_servers is not in [mcp_servers.<name>] tables) — left as it is',
    )
    expect(result.stdout).toContain(CODEX_MCP_USER_STEP_HINT)
    expect(CODEX_MCP_USER_STEP_HINT).toContain('codex mcp add sofar -- sofar mcp')
    expect(config(root)).toBe(mine)
    expect(init(root).stdout).toContain(CODEX_MCP_USER_STEP_HINT) // said until it is done
  })

  it('says nothing more once the user config registers sofar', () => {
    const root = freshRepo('a = "open\n')
    const result = runInit(
      root,
      { agents: ['codex'], home: home(root, CODEX_MCP_TABLE) },
      plain,
      plain,
    )
    expect(result.stdout).toContain(
      'unchanged .codex/config.toml (sofar could not read it as TOML; your user config registers sofar)',
    )
    expect(result.stdout).not.toContain(CODEX_MCP_USER_STEP_HINT)
    expect(config(root)).toBe('a = "open\n')
  })

  it('counts the server alone as Codex wired', () => {
    const root = freshRepo(CODEX_MCP_TABLE)
    expect(wiredAgents(root)).toEqual(['codex'])
    expect(wiredAgents(freshRepo('model = "o3"\n'))).toEqual([])
  })
})

describe('direct tool calls under Codex code mode (r3-fixes 2.7)', () => {
  it('reads every form a direct_only_tool_namespaces or a code_mode can take', () => {
    expect(codexDirectState('')).toBe('absent')
    expect(codexDirectState('[features]\nhooks = true\n')).toBe('absent')
    expect(codexDirectState('features.hooks = true\n')).toBe('absent') // a sub-table of a dotted table is allowed
    expect(codexDirectState('[features.code_mode]\nenabled = true\n')).toBe('table')
    expect(codexDirectState(`[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__x"]\n`)).toBe('set') // the user's list wins
    expect(codexDirectState('features.code_mode.direct_only_tool_namespaces = []\n')).toBe('set')
    expect(codexDirectState('[features]\ncode_mode = { direct_only_tool_namespaces = [] }\n')).toBe('set')
    expect(codexDirectState('[features]\ncode_mode = true\n')).toBe('blocked')
    expect(codexDirectState('features.code_mode.enabled = true\n')).toBe('blocked') // defined by dotted keys
    expect(codexDirectState('features = { hooks = true }\n')).toBe('blocked')
    expect(codexDirectState('a = "open\n')).toBe('unreadable')
  })

  it('inserts the key under the user\'s table, and uninit takes back only that line', () => {
    const mine = '[features.code_mode]\nenabled = true\n\n[projects."/x"]\ntrust_level = "trusted"\n'
    const inserted = withSofarDirect(mine, 'table')
    expect(inserted).toBe(`[features.code_mode]\n${CODEX_DIRECT_KEY}\nenabled = true\n\n[projects."/x"]\ntrust_level = "trusted"\n`)
    expect(codexDirectState(inserted)).toBe('set')
    expect(withoutSofarDirect(inserted)).toBe(mine)
    expect(withoutSofarDirect(`[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__x"]\n`)).toBe(
      `[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__x"]\n`,
    )
  })

  it('adds the key to a registered project on re-init, once; leaves a clashing code_mode and names the line', () => {
    const root = freshRepo(`${CODEX_MCP_TABLE}`) // an older init's file
    const result = init(root)
    expect(result.stdout).toContain("updated .codex/config.toml (Codex calls sofar's tools directly)")
    // …and 0.34's own table, byte for byte, now lists only the write-back (r4-fixes A2).
    expect(config(root)).toBe(`${DEFAULT_TABLE}\n${CODEX_DIRECT_TABLE}`)
    expect(init(root).stdout).not.toContain('directly')

    const clash = freshRepo('[features]\ncode_mode = true\n')
    const out = init(clash).stdout
    expect(out).toContain(
      `skipped direct tool calls in .codex/config.toml (its features.code_mode is not a [features.code_mode] table) — add \`${CODEX_DIRECT_KEY}\` under [features.code_mode] by hand`,
    )
    expect(config(clash)).toBe(`[features]\ncode_mode = true\n\n${DEFAULT_TABLE}`)
  })
})

describe('sofar uninit and .codex/config.toml', () => {
  it('deletes a file that held only sofar’s table, and .codex/ with it, on --purge', () => {
    const root = freshRepo()
    init(root)
    expect(runUninit(root, { purge: true }, plain, plain).stdout).toContain(
      'removed .codex/config.toml (nothing left after sofar server entry removed)',
    )
    expect(existsSync(join(root, '.codex'))).toBe(false)
  })

  it('keeps an emptied file without --purge', () => {
    const root = freshRepo()
    init(root)
    expect(runUninit(root, {}, plain, plain).stdout).toContain('updated .codex/config.toml (sofar server entry removed)')
    expect(config(root)).toBe('')
  })

  it('warns, and edits nothing, when sofar sits outside a table or the file cannot be read', () => {
    const inline = '[mcp_servers]\nsofar = { command = "sofar" }\n'
    const root = freshRepo(inline)
    const result = runUninit(root, { purge: true }, plain, plain)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('defines a sofar MCP server outside a [mcp_servers.sofar] table — left')
    expect(config(root)).toBe(inline)

    const broken = freshRepo('[mcp_servers.sofar]\ncommand = "open\n')
    const again = runUninit(broken, { purge: true }, plain, plain)
    expect(again.exitCode).toBe(0)
    expect(again.stderr).toContain('.codex/config.toml could not be read as TOML')
    expect(config(broken)).toBe('[mcp_servers.sofar]\ncommand = "open\n')
  })
})

describe('sofar doctor and Codex’s MCP server', () => {
  function doctor(root: string, homeDir = home(root)) {
    return runDoctor(root, { home: homeDir }, plain)
  }

  it('passes on the project table and fails without it, naming init', () => {
    const root = freshRepo()
    init(root)
    expect(doctor(root).stdout).toContain('.codex/config.toml sofar server registered')

    writeFileSync(join(root, CODEX_CONFIG), 'model = "o3"\n')
    const result = doctor(root)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('.codex/config.toml sofar server not registered')
    expect(result.stdout).toContain('run `sofar init --refresh` to (re)install it')
  })

  it('warns, naming the line, when a registered table does not pre-approve sofar’s tools (3.4)', () => {
    const root = freshRepo()
    init(root)
    expect(doctor(root).stdout).not.toContain('sofar tools not pre-approved')

    writeFileSync(join(root, CODEX_CONFIG), '[mcp_servers.sofar]\ncommand = "sofar"\nargs = ["mcp"]\n')
    const result = doctor(root)
    expect(result.stdout).toContain('.codex/config.toml sofar server registered')
    expect(result.stdout).toContain('.codex/config.toml sofar tools not pre-approved')
    expect(result.stdout).toContain(`add \`${CODEX_TOOLS_APPROVAL}\` under [mcp_servers.sofar] in .codex/config.toml`)
  })

  it('names the user-level step for a file init leaves, and passes once the user config has it', () => {
    const root = freshRepo('mcp_servers.docs.command = "npx"\n')
    init(root)
    const result = doctor(root)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(
      '.codex/config.toml defines mcp_servers outside [mcp_servers.<name>] tables, so init leaves it — run `codex mcp add sofar -- sofar mcp` once',
    )

    const done = doctor(root, home(root, `model = "o3"\n\n${CODEX_MCP_TABLE}`))
    expect(done.stdout).toContain('Codex sofar server registered in your user config.toml')
    expect(done.stdout).not.toContain('sofar server not registered')
  })

  it('reads the user config from CODEX_HOME, else ~/.codex', () => {
    vi.stubEnv('CODEX_HOME', '/elsewhere/codex')
    expect(codexUserConfigPath()).toBe(join('/elsewhere/codex', 'config.toml'))
    expect(codexUserConfigPath('/home/me')).toBe(join('/home/me', '.codex', 'config.toml'))
    vi.stubEnv('CODEX_HOME', '')
    expect(codexUserConfigPath().endsWith(join('.codex', 'config.toml'))).toBe(true)
  })
})
