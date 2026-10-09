import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INSTALL_COMMAND,
  canCreate,
  dirOnPath,
  installedSofarOnPath,
  isNpxRun,
  npxInitRefusal,
  pathExportLine,
  planInstall,
  prefixFromNpmOutput,
  runNpxInstall,
  shellRcFile,
  type NpxInstallDeps,
} from '../src/cli/npx-install'

/**
 * `npx sofar.sh` installs sofar (r4-fixes H10). npx runs a package from its
 * cache and puts nothing on PATH, while the hooks `sofar init` writes call
 * `sofar` from PATH — so the bare npx run offers the install, an npx `init`
 * refuses, and the decisions are pure functions over paths, PATH and answers.
 */

const npxCache = '/Users/x/.npm/_npx/abc123/node_modules/sofar.sh/dist/full.js'
const globalInstall = '/usr/local/lib/node_modules/sofar.sh/dist/full.js'
const localDep = '/Users/x/proj/node_modules/sofar.sh/dist/full.js'
const sourceCheckout = '/Users/x/sofar/packages/engine/dist/full.js'

const temps: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-npx-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An executable `sofar` in `dir`. */
function fakeSofar(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'sofar')
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

describe('isNpxRun — an npx run, told apart by its own path', () => {
  it('is true from the _npx cache', () => {
    expect(isNpxRun(npxCache, {})).toBe(true)
  })
  it('is true for a local dependency that npm exec launched', () => {
    expect(isNpxRun(localDep, { npm_command: 'exec' })).toBe(true)
  })
  it('is false for a global install, a package.json script and a source checkout', () => {
    expect(isNpxRun(globalInstall, { npm_command: 'exec' })).toBe(false)
    expect(isNpxRun(localDep, { npm_command: 'run-script' })).toBe(false)
    expect(isNpxRun(sourceCheckout, { npm_command: 'exec' })).toBe(false)
  })
})

describe('installedSofarOnPath — what a new shell would find', () => {
  it("ignores the run's own npx cache and node_modules/.bin entries", () => {
    const root = temp()
    const npxBin = join(root, '_npx', 'h', 'node_modules', '.bin')
    const localBin = join(root, 'proj', 'node_modules', '.bin')
    fakeSofar(npxBin)
    fakeSofar(localBin)
    expect(installedSofarOnPath({ PATH: [npxBin, localBin].join(delimiter) }, 'darwin')).toBeNull()
  })
  it('finds an installed sofar in a real bin dir, and skips one that is not executable', () => {
    const root = temp()
    const plain = join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'sofar'), 'not executable')
    const bin = join(root, 'prefix', 'bin')
    const sofar = fakeSofar(bin)
    expect(installedSofarOnPath({ PATH: plain }, 'darwin')).toBeNull()
    expect(installedSofarOnPath({ PATH: [plain, bin].join(delimiter) }, 'darwin')).toBe(sofar)
  })
})

describe('planInstall — this version, globally, never sudo', () => {
  it("uses npm's global prefix when this user can write it", () => {
    const plan = planInstall('/opt/homebrew', '/Users/x', () => true, 'darwin', '9.9.9')
    expect(plan).toEqual({
      prefix: '/opt/homebrew',
      fallback: false,
      args: ['install', '-g', '--prefix', '/opt/homebrew', 'sofar.sh@9.9.9', '--allow-scripts=sofar.sh'],
    })
  })
  it('falls back to ~/.local when the global prefix needs root, or npm cannot name one', () => {
    const fallback = {
      prefix: '/Users/x/.local',
      fallback: true,
      args: ['install', '-g', '--prefix', '/Users/x/.local', 'sofar.sh@9.9.9', '--allow-scripts=sofar.sh'],
    }
    expect(planInstall('/usr/local', '/Users/x', () => false, 'darwin', '9.9.9')).toEqual(fallback)
    expect(planInstall(null, '/Users/x', () => true, 'darwin', '9.9.9')).toEqual(fallback)
  })
})

describe("prefixFromNpmOutput — only a prefix that exists", () => {
  it('takes an existing directory, trimmed', () => {
    expect(prefixFromNpmOutput('/opt/homebrew\n', (p) => p === '/opt/homebrew')).toBe('/opt/homebrew')
  })
  it("refuses npm 12's masked output and anything else that does not exist", () => {
    expect(prefixFromNpmOutput('/tmp/***/global\n', () => false)).toBeNull()
    expect(prefixFromNpmOutput('\n', () => true)).toBeNull()
  })
})

describe('canCreate — the nearest existing ancestor decides', () => {
  it('is true for a missing dir under a writable one', () => {
    expect(canCreate(join(temp(), 'lib', 'node_modules'))).toBe(true)
  })
  it.skipIf(process.getuid?.() === 0)('is false under a read-only dir', () => {
    const root = temp()
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      expect(canCreate(join(locked, 'lib', 'node_modules'))).toBe(false)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe('PATH helpers', () => {
  it('picks the rc file for zsh (ZDOTDIR honoured) and bash, and none for other shells', () => {
    expect(shellRcFile({ SHELL: '/bin/zsh' }, '/Users/x', 'darwin')).toBe('/Users/x/.zshrc')
    expect(shellRcFile({ SHELL: '/bin/zsh', ZDOTDIR: '/Users/x/.config/zsh' }, '/Users/x', 'darwin')).toBe('/Users/x/.config/zsh/.zshrc')
    expect(shellRcFile({ SHELL: '/bin/bash' }, '/Users/x', 'darwin')).toBe('/Users/x/.bash_profile')
    expect(shellRcFile({ SHELL: '/bin/bash' }, '/home/x', 'linux')).toBe('/home/x/.bashrc')
    expect(shellRcFile({ SHELL: '/usr/bin/fish' }, '/home/x', 'linux')).toBeNull()
  })
  it('spells a home bin dir with $HOME', () => {
    expect(pathExportLine('/Users/x/.local/bin', '/Users/x')).toBe('export PATH="$HOME/.local/bin:$PATH"')
    expect(pathExportLine('/opt/tools/bin', '/Users/x')).toBe('export PATH="/opt/tools/bin:$PATH"')
  })
  it('compares PATH entries without trailing slashes and ignores npx entries', () => {
    expect(dirOnPath('/Users/x/.local/bin', { PATH: `/usr/bin${delimiter}/Users/x/.local/bin/` })).toBe(true)
    expect(dirOnPath('/a/_npx/h/node_modules/.bin', { PATH: '/a/_npx/h/node_modules/.bin' })).toBe(false)
  })
})

/** Scripted deps: answers in order, a fake npm that drops a sofar into the prefix's bin. */
function harness(over: Partial<NpxInstallDeps> & { answers?: string[]; prefixWritable?: boolean } = {}) {
  const home = over.home ?? temp()
  const globalPrefix = join(home, 'global')
  const answers = [...(over.answers ?? [])]
  const asked: string[] = []
  const written: string[] = []
  const npmCalls: string[][] = []
  const initCalls: Array<[string, string]> = []
  const appended: Array<[string, string]> = []
  const files = new Map<string, string>()
  const deps: NpxInstallDeps = {
    prompt: {
      interactive: true,
      ask: async (q) => {
        asked.push(q)
        return answers.shift() ?? ''
      },
    },
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    home,
    cwd: home,
    platform: 'darwin',
    write: (line) => written.push(line),
    globalPrefix: () => globalPrefix,
    writable: () => over.prefixWritable ?? true,
    runNpm: async (args) => {
      npmCalls.push(args)
      fakeSofar(join(args[args.indexOf('--prefix') + 1]!, 'bin'))
      return 0
    },
    runInit: async (sofar, cwd) => {
      initCalls.push([sofar, cwd])
      return 0
    },
    append: (file, text) => {
      appended.push([file, text])
      files.set(file, (files.get(file) ?? '') + text)
    },
    read: (file) => files.get(file) ?? null,
    version: '9.9.9',
    ...over,
  }
  return { deps, home, globalPrefix, asked, written, npmCalls, initCalls, appended, files }
}

describe('runNpxInstall — the bare `npx sofar.sh` flow', () => {
  it('without a terminal installs nothing and names the command', async () => {
    const h = harness()
    const result = await runNpxInstall({ ...h.deps, prompt: { interactive: false, ask: async () => 'y' } })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(INSTALL_COMMAND)
    expect(h.npmCalls).toEqual([])
  })

  it('declined, installs nothing', async () => {
    const h = harness({ answers: ['n'] })
    const result = await runNpxInstall(h.deps)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Not installed')
    expect(h.npmCalls).toEqual([])
  })

  it('accepted with a writable prefix already on PATH: one npm call, no PATH question', async () => {
    const h = harness({ answers: [''] })
    h.deps.env = { SHELL: '/bin/zsh', PATH: join(h.globalPrefix, 'bin') }
    const result = await runNpxInstall(h.deps)
    expect(result.exitCode).toBe(0)
    expect(h.npmCalls).toEqual([['install', '-g', '--prefix', h.globalPrefix, 'sofar.sh@9.9.9', '--allow-scripts=sofar.sh']])
    expect(h.asked).toHaveLength(1)
    expect(h.written.some((l) => l.startsWith('✓ installed sofar 9.9.9'))).toBe(true)
    expect(result.stdout).toContain('cd into your project and run `sofar init`')
  })

  it('falls back to ~/.local, and adds it to PATH in the zsh rc once', async () => {
    const h = harness({ answers: ['y', 'y'], prefixWritable: false })
    const result = await runNpxInstall(h.deps)
    expect(result.exitCode).toBe(0)
    expect(h.npmCalls[0]).toEqual(['install', '-g', '--prefix', join(h.home, '.local'), 'sofar.sh@9.9.9', '--allow-scripts=sofar.sh'])
    expect(h.written.some((l) => l.includes('needs sudo'))).toBe(true)
    expect(h.appended).toEqual([[join(h.home, '.zshrc'), '\n# added by sofar (npx sofar.sh)\nexport PATH="$HOME/.local/bin:$PATH"\n']])
    expect(result.stdout).toContain('Open a new terminal')

    // a second run finds the line already there and leaves the rc alone
    const again = harness({ answers: ['y'], prefixWritable: false, home: h.home })
    again.files.set(join(h.home, '.zshrc'), h.files.get(join(h.home, '.zshrc'))!)
    const second = await runNpxInstall(again.deps)
    expect(again.appended).toEqual([])
    expect(second.stdout).toContain('already puts')
  })

  it('declining the PATH edit prints the line to add instead', async () => {
    const h = harness({ answers: ['y', 'n'], prefixWritable: false })
    const result = await runNpxInstall(h.deps)
    expect(h.appended).toEqual([])
    expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"')
  })

  it('offers sofar init in a git repo without a record, and runs the installed sofar there', async () => {
    const h = harness({ answers: ['y', 'y'] })
    h.deps.env = { SHELL: '/bin/zsh', PATH: join(h.globalPrefix, 'bin') }
    const repo = join(h.home, 'proj')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'))
    h.deps.cwd = join(repo, 'src')
    await runNpxInstall(h.deps)
    expect(h.initCalls).toEqual([[join(h.globalPrefix, 'bin', 'sofar'), repo]])
  })

  it('leaves a repo that already has a record alone', async () => {
    const h = harness({ answers: ['y'] })
    h.deps.env = { SHELL: '/bin/zsh', PATH: join(h.globalPrefix, 'bin') }
    const repo = join(h.home, 'proj')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.sofar'))
    h.deps.cwd = repo
    const result = await runNpxInstall(h.deps)
    expect(h.asked).toHaveLength(1)
    expect(h.initCalls).toEqual([])
    expect(result.stdout).toBe('')
  })

  it("passes npm's failure through and asks nothing more", async () => {
    const h = harness({ answers: ['y'], runNpm: async () => 7 })
    const result = await runNpxInstall(h.deps)
    expect(result.exitCode).toBe(7)
    expect(h.asked).toHaveLength(1)
  })

  it('fails when npm succeeds but no sofar landed', async () => {
    const h = harness({ answers: ['y'], runNpm: async () => 0 })
    const result = await runNpxInstall(h.deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('no sofar landed')
  })
})

describe('npxInitRefusal — init from npx would wire hooks that call a missing sofar', () => {
  it('refuses from the npx cache with no installed sofar', () => {
    const refusal = npxInitRefusal(npxCache, { PATH: '/usr/bin' }, 'darwin')
    expect(refusal).toContain('nothing was written')
    expect(refusal).toContain(INSTALL_COMMAND)
  })
  it('goes ahead when a sofar is installed, or when this is not an npx run', () => {
    const bin = join(temp(), 'bin')
    fakeSofar(bin)
    expect(npxInitRefusal(npxCache, { PATH: bin }, 'darwin')).toBeNull()
    expect(npxInitRefusal(globalInstall, { PATH: '/usr/bin' }, 'darwin')).toBeNull()
  })
})

// The built CLI run from an npx-cache layout: proves the bundle's own path is
// what decides, end to end, with no npm involved.
const dist = join(__dirname, '..', 'dist')
describe.skipIf(!existsSync(join(dist, 'cli.js')))('the built CLI from an npx cache layout', () => {
  function npxLayout(): { cli: string; repo: string; env: NodeJS.ProcessEnv } {
    const root = temp()
    const pkg = join(root, '_npx', 'abc123', 'node_modules', 'sofar.sh')
    cpSync(dist, join(pkg, 'dist'), { recursive: true })
    cpSync(join(__dirname, '..', 'package.json'), join(pkg, 'package.json'))
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const env: NodeJS.ProcessEnv = {
      PATH: [join(root, '_npx', 'abc123', 'node_modules', '.bin'), '/usr/bin', '/bin'].join(delimiter),
      HOME: root,
      SOFAR_NO_UPDATE_CHECK: '1',
      SOFAR_CORE: '0',
      TERM: 'dumb',
    }
    return { cli: join(pkg, 'dist', 'cli.js'), repo, env }
  }

  it('a bare run with no terminal names the install command and installs nothing', () => {
    const { cli, repo, env } = npxLayout()
    const run = spawnSync(process.execPath, [cli], { cwd: repo, env, encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(INSTALL_COMMAND)
  })

  it('init refuses and writes nothing', () => {
    const { cli, repo, env } = npxLayout()
    const run = spawnSync(process.execPath, [cli, 'init', '--agents', 'claude-code', '--root', repo], { cwd: repo, env, encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('nothing was written')
    expect(existsSync(join(repo, '.sofar'))).toBe(false)
    expect(existsSync(join(repo, '.claude'))).toBe(false)
  })

  it('init goes ahead once a sofar is installed on PATH', () => {
    const { cli, repo, env } = npxLayout()
    const bin = join(repo, '..', 'prefix', 'bin')
    fakeSofar(bin)
    const run = spawnSync(process.execPath, [cli, 'init', '--agents', 'claude-code', '--root', repo], {
      cwd: repo,
      env: { ...env, PATH: `${bin}${delimiter}${env.PATH}` },
      encoding: 'utf8',
    })
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(join(repo, '.sofar'))).toBe(true)
  })

  it('--version is untouched', () => {
    const { cli, repo, env } = npxLayout()
    const run = spawnSync(process.execPath, [cli, '--version'], { cwd: repo, env, encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
  })
})
