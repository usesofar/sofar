import { execFileSync, spawn } from 'node:child_process'
import { accessSync, appendFileSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { version as CURRENT_VERSION } from '../../package.json'
import { gitToplevel } from '../core/git'
import { fail, ok, type CmdResult } from './shared'
import { planUpgrade } from './update-cache'
import { PACKAGE_NAME } from './upgrade'

/**
 * `npx sofar.sh` installs sofar (r4-fixes H10).
 *
 * sofar.sh's site and README hand out `npx sofar.sh` as the way in, but npx
 * only runs a package from its cache: nothing lands on PATH, and the hooks
 * `sofar init` writes call `sofar` from PATH (`exec sofar event stop`), so an
 * init run from npx wires hooks that fail on the next prompt. Three surfaces
 * close that gap, all keyed on "this process is an npx run and no installed
 * `sofar` is on PATH":
 *
 * - `npx sofar.sh` with no arguments, on a terminal, offers to install this
 *   version globally (native core allowed), falls back to ~/.local when npm's
 *   global prefix needs root, offers to put that bin dir on PATH, then offers
 *   `sofar init` for the repo it is standing in. Every step asks; Enter is yes.
 * - `sofar init` from npx refuses before writing anything.
 * - Any other command from npx adds one stderr line saying how to install,
 *   on a terminal only.
 *
 * Nothing here runs on the hook path: the boot stub sends `event` and
 * `statusline` to fast.js, which never loads this module.
 */

export type Env = Record<string, string | undefined>

/** The command line every surface hands out when it cannot install itself. */
export const INSTALL_COMMAND = `npm i -g ${PACKAGE_NAME} --allow-scripts=${PACKAGE_NAME}`

/** Where the install goes when npm's global prefix is not writable without sudo. */
export function fallbackPrefix(home: string): string {
  return join(home, '.local')
}

/**
 * Is this process an npx run? The running bundle sits in a node_modules tree
 * that is not a global install (planUpgrade's test) and npm launched it to
 * execute a bin: the `_npx` cache, or `npm exec`/`npx` resolving a local
 * dependency (npm sets npm_command=exec for its children). A source checkout
 * and a global install are never npx runs; neither is a package.json script.
 */
export function isNpxRun(selfPath: string, env: Env): boolean {
  const segments = selfPath.split(sep)
  if (!segments.includes('node_modules')) return false
  if (planUpgrade(selfPath).kind === 'global-npm') return false
  return segments.includes('_npx') || env.npm_command === 'exec'
}

/** The executable names `sofar` resolves to on this platform. */
function commandNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['sofar.cmd', 'sofar.exe', 'sofar.ps1'] : ['sofar']
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A PATH entry that npm put there for this run only: npx's cache and every
 * `node_modules/.bin` npm exec prepends for the cwd and its ancestors. A
 * `sofar` found there disappears with the run, so it does not count.
 */
function transientBinDir(dir: string): boolean {
  const segments = dir.split(sep)
  return segments.includes('_npx') || segments.includes('node_modules')
}

/** The installed `sofar` a new shell would find, or null. */
export function installedSofarOnPath(env: Env, platform: NodeJS.Platform = process.platform): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0 || transientBinDir(dir)) continue
    for (const name of commandNames(platform)) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate, platform)) return candidate
    }
  }
  return null
}

/** `dir` without trailing separators, so `/a/bin/` and `/a/bin` compare equal. */
function trimSep(dir: string): string {
  let end = dir.length
  while (end > 1 && dir[end - 1] === sep) end--
  return dir.slice(0, end)
}

/** Is `dir` on PATH, ignoring the run's own transient entries? */
export function dirOnPath(dir: string, env: Env): boolean {
  const want = trimSep(dir)
  return (env.PATH ?? '')
    .split(delimiter)
    .some((entry) => entry.length > 0 && !transientBinDir(entry) && trimSep(entry) === want)
}

/** Can files be created at `dir`? Checks the nearest existing ancestor, since a fresh prefix may lack lib/ or bin/. */
export function canCreate(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(current)) {
      try {
        accessSync(current, constants.W_OK)
        return true
      } catch {
        return false
      }
    }
    if (dirname(current) === current) return false
  }
}

/** Where npm puts a global install's bins under `prefix`. */
export function binDirOf(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? prefix : join(prefix, 'bin')
}

/** Where npm puts a global install's packages under `prefix`. */
function libDirOf(prefix: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
}

export interface InstallPlan {
  /** The prefix the install lands in. */
  prefix: string
  /** True when npm's own global prefix was not writable and the fallback was chosen. */
  fallback: boolean
  /** npm's argv. */
  args: string[]
}

/**
 * Install exactly the version that is running, globally, with sofar's
 * install script allowed (npm 12 skips it otherwise; npm 10 and 11 run it
 * anyway and accept the flag). npm's global prefix when this user can write
 * it, else ~/.local — never sudo. The prefix is always passed explicitly, so
 * npm installs exactly where the run then looks for the new `sofar`, whatever
 * an npmrc or the environment says (the same choice `sofar upgrade` makes).
 */
export function planInstall(
  globalPrefix: string | null,
  home: string,
  writable: (dir: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  version: string = CURRENT_VERSION,
): InstallPlan {
  const usable =
    globalPrefix !== null && writable(libDirOf(globalPrefix, platform)) && writable(binDirOf(globalPrefix, platform))
  const prefix = usable ? globalPrefix : fallbackPrefix(home)
  return {
    prefix,
    fallback: !usable,
    args: ['install', '-g', '--prefix', prefix, `${PACKAGE_NAME}@${version}`, `--allow-scripts=${PACKAGE_NAME}`],
  }
}

/** The shell startup file a PATH line belongs in, or null when the shell is not one sofar edits. */
export function shellRcFile(env: Env, home: string, platform: NodeJS.Platform = process.platform): string | null {
  const shell = basename(env.SHELL ?? '')
  if (shell === 'zsh') return join(env.ZDOTDIR ?? home, '.zshrc')
  if (shell === 'bash') return join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc')
  return null
}

/** The line that puts `binDir` on PATH, spelled with $HOME when it lives there. */
export function pathExportLine(binDir: string, home: string): string {
  const shown = binDir === home || binDir.startsWith(`${home}${sep}`) ? `$HOME${binDir.slice(home.length)}` : binDir
  return `export PATH="${shown}:$PATH"`
}

/** Shell-quote one argv word for display. */
function shown(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

export interface NpxPrompt {
  interactive: boolean
  ask(question: string): Promise<string>
}

export interface NpxInstallDeps {
  prompt: NpxPrompt
  env: Env
  home: string
  cwd: string
  platform: NodeJS.Platform
  /** Progress lines (stderr in the CLI). */
  write(line: string): void
  /** `npm prefix -g`, or null when npm cannot say. */
  globalPrefix(): string | null
  writable(dir: string): boolean
  /** Runs npm with these args, its output inherited; resolves with the exit code. */
  runNpm(args: string[]): Promise<number>
  /** Runs the installed `sofar init` in `cwd`, inherited stdio; resolves with the exit code. */
  runInit(sofar: string, cwd: string): Promise<number>
  /** Appends text to a file (the shell rc). */
  append(file: string, text: string): void
  read(file: string): string | null
  version?: string
}

/** Enter, y and yes are yes; anything else is no. */
function yes(answer: string): boolean {
  const a = answer.trim().toLowerCase()
  return a === '' || a === 'y' || a === 'yes'
}

/** The bare `npx sofar.sh` flow. Returns what the CLI emits once it is done. */
export async function runNpxInstall(deps: NpxInstallDeps): Promise<CmdResult> {
  const version = deps.version ?? CURRENT_VERSION
  if (!deps.prompt.interactive) {
    return fail(
      `sofar ${version} is running from npx's cache, so nothing is installed and there is no \`sofar\` command.\n` +
        `Install it with: ${INSTALL_COMMAND}\n` +
        `(or run \`npx sofar.sh\` in a terminal and it will offer to install itself)`,
    )
  }

  deps.write(`sofar ${version} is running from npx's cache, so nothing is installed yet.`)
  deps.write('The `sofar` command, and the hooks `sofar init` sets up, need it installed.')
  if (!yes(await deps.prompt.ask(`Install sofar ${version} now? [Y/n] `))) {
    return ok(`Not installed. To install later: ${INSTALL_COMMAND}\n`)
  }

  const plan = planInstall(deps.globalPrefix(), deps.home, deps.writable, deps.platform, version)
  if (plan.fallback) {
    deps.write(`npm's global folder needs sudo here, so sofar goes into ${plan.prefix} instead.`)
  }
  deps.write(`→ npm ${plan.args.map(shown).join(' ')}`)
  let code: number
  try {
    code = await deps.runNpm(plan.args)
  } catch (err) {
    return fail(`could not run npm (${err instanceof Error ? err.message : String(err)}). Install with: ${INSTALL_COMMAND}`)
  }
  if (code !== 0) return { exitCode: code, stdout: '', stderr: `npm exited ${code} (see its output above); nothing else was changed.` }

  const binDir = binDirOf(plan.prefix, deps.platform)
  const sofar = commandNames(deps.platform)
    .map((name) => join(binDir, name))
    .find((path) => existsSync(path))
  if (sofar === undefined) return fail(`npm finished, but no sofar landed in ${binDir}. Install with: ${INSTALL_COMMAND}`)
  deps.write(`✓ installed sofar ${version}: ${sofar}`)

  const lines: string[] = []
  if (!dirOnPath(binDir, deps.env)) {
    const line = pathExportLine(binDir, deps.home)
    const rc = shellRcFile(deps.env, deps.home, deps.platform)
    const already = rc !== null && (deps.read(rc) ?? '').includes(line)
    if (rc !== null && !already && yes(await deps.prompt.ask(`${binDir} is not on your PATH. Add it to ${rc}? [Y/n] `))) {
      deps.append(rc, `\n# added by sofar (npx sofar.sh)\n${line}\n`)
      lines.push(`Added to ${rc}. Open a new terminal (or run \`source ${rc}\`) and \`sofar\` will be found.`)
    } else if (rc !== null && already) {
      lines.push(`${rc} already puts ${binDir} on PATH. Open a new terminal and \`sofar\` will be found.`)
    } else {
      lines.push(`${binDir} is not on your PATH. Add this line to your shell's startup file, then open a new terminal:`)
      lines.push(`  ${line}`)
    }
  }

  const repo = gitToplevel(deps.cwd)
  if (repo !== null && !existsSync(join(repo, '.sofar'))) {
    if (yes(await deps.prompt.ask(`Set up ${basename(repo)} for sofar now (sofar init)? [Y/n] `))) {
      const initCode = await deps.runInit(sofar, repo)
      if (initCode !== 0) lines.push(`sofar init exited ${initCode}; run it again from ${repo} when ready.`)
    } else {
      lines.push(`Next: run \`sofar init\` in ${repo}.`)
    }
  } else if (repo === null) {
    lines.push('Next: cd into your project and run `sofar init`.')
  }
  return ok(lines.length > 0 ? `${lines.join('\n')}\n` : '')
}

/** `sofar init` from npx with no installed sofar: the refusal, or null to go ahead. */
export function npxInitRefusal(selfPath: string, env: Env, platform: NodeJS.Platform = process.platform): string | null {
  if (!isNpxRun(selfPath, env) || installedSofarOnPath(env, platform) !== null) return null
  return [
    "sofar init: sofar is running from npx's cache and is not installed, so the hooks init writes",
    '(which run `sofar`) would fail on the first prompt — nothing was written.',
    '  install first: run `npx sofar.sh` with no arguments, or',
    `  ${INSTALL_COMMAND}`,
    '  then run `sofar init` again.',
  ].join('\n')
}

/** The one stderr line any other command adds when run from npx with no installed sofar. */
export const NPX_HINT = "sofar: running from npx's cache, not installed — run `npx sofar.sh` with no arguments to install it."

/**
 * `npm prefix -g`'s output as a prefix, or null unless it names an existing
 * directory. npm 12 masks anything shaped like a UUID in what it prints (a
 * path segment included, as `***`), and a masked path that does not exist
 * would send the writability check up to whatever ancestor does.
 */
export function prefixFromNpmOutput(out: string, isDir: (path: string) => boolean): string | null {
  const trimmed = out.trim()
  return trimmed.length > 0 && isDir(trimmed) ? trimmed : null
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** npm's global prefix, or null when npm cannot name one that exists. */
export function npmGlobalPrefix(): string | null {
  try {
    const out = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return prefixFromNpmOutput(out, isDirectory)
  } catch {
    return null
  }
}

function inherit(command: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...(cwd === undefined ? {} : { cwd }), shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** The real-world dependencies, for the CLI. */
export function liveNpxInstallDeps(prompt: NpxPrompt): NpxInstallDeps {
  return {
    prompt,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    write: (line) => process.stderr.write(`${line}\n`),
    globalPrefix: npmGlobalPrefix,
    writable: canCreate,
    runNpm: (args) => inherit('npm', args),
    runInit: (sofar, cwd) => inherit(sofar, ['init'], cwd),
    append: (file, text) => appendFileSync(file, text),
    read: (file) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
  }
}
