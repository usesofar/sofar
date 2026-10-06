import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import { runInit } from '../src/cli/init'
import { runDoctor } from '../src/cli/doctor'
import type { Caps } from '../src/cli/ui'

/**
 * cli-ui 2.4 — styled `sofar doctor`. All caps are passed explicitly (no TTY
 * faking): the styled path is exercised with color on, and the plain path is
 * locked byte-identical to the pre-styling render. The scan spinner is
 * captured through an injected stream on an inert-by-default progress channel.
 */

const STYLED: Caps = { color: true, unicode: true, animate: false }
const PLAIN: Caps = { color: false, unicode: true, animate: false }
/** A piped stderr: the spinner must write nothing at all. */
const INERT: Caps = { color: false, unicode: false, animate: false }

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-doctor-ui-'))
  roots.push(root)
  return root
}
function pkg(root: string, deps: Record<string, string>): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps }, null, 2))
}
function css(root: string, rel: string, content: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}
function capture(): { chunks: string[]; write: (c: string) => void } {
  const chunks: string[] = []
  return { chunks, write: (c: string) => chunks.push(c) }
}

describe('sofar doctor: plain path stays byte-identical', () => {
  it('renders the legacy markers and no escapes when color is off', () => {
    const root = tmpRepo()
    runInit(root)
    const r = runDoctor(root, {}, PLAIN, { caps: INERT, stream: capture() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.startsWith(`sofar doctor — ${root}\n\nWiring integrity:\n  ok    `)).toBe(true)
    expect(r.stdout).toContain('\nsofar doctor: no problems found\n')
    expect(r.stdout).not.toContain('\x1b[')
  })

  it('default caps thread through detection and match explicit plain caps', () => {
    const root = tmpRepo()
    runInit(root)
    // NO_COLOR beats every other signal (CI, FORCE_COLOR), so the default
    // stdoutCaps()/stderrCaps() path is deterministically plain here.
    vi.stubEnv('NO_COLOR', '1')
    try {
      const dflt = runDoctor(root)
      const plain = runDoctor(root, {}, PLAIN, { caps: INERT, stream: capture() })
      expect(dflt.stdout).toBe(plain.stdout)
      expect(dflt.exitCode).toBe(plain.exitCode)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('color gates the layout: a NO_COLOR TTY (animate on) still gets plain bytes', () => {
    const root = tmpRepo()
    runInit(root)
    const noColorTty = runDoctor(
      root,
      {},
      { color: false, unicode: true, animate: true },
      { caps: INERT, stream: capture() },
    )
    const plain = runDoctor(root, {}, PLAIN, { caps: INERT, stream: capture() })
    expect(noColorTty.stdout).toBe(plain.stdout)
  })

  it('plain fail output keeps the exit-1 contract and hint indentation', () => {
    const root = tmpRepo()
    runInit(root)
    unlinkSync(join(root, '.claude', 'hooks', 'stop.sh'))
    const r = runDoctor(root, {}, PLAIN, { caps: INERT, stream: capture() })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain(
      '  FAIL  hook shims missing: stop.sh\n          run `sofar init --refresh` to (re)install it',
    )
  })
})

describe('sofar doctor: styled path', () => {
  it('renders bold sections, green ✓ marks, bold summary with green count on a clean repo', () => {
    const root = tmpRepo()
    runInit(root)
    const r = runDoctor(root, {}, STYLED, { caps: INERT, stream: capture() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.startsWith('\x1b[1msofar doctor\x1b[22m \x1b[2m— ')).toBe(true)
    expect(r.stdout).toContain('\x1b[1mWiring integrity:\x1b[22m')
    expect(r.stdout).toContain('  \x1b[32m✓\x1b[39m .sofar/bindings.json present')
    expect(r.stdout).toContain('\x1b[1msofar doctor: \x1b[32mno problems found\x1b[39m\x1b[22m')
    expect(r.stdout).not.toContain('  ok  ') // legacy markers gone on the styled path
  })

  it('renders fail findings as red ✗ with a dim └ hint; exit code unchanged', () => {
    const root = tmpRepo()
    runInit(root)
    unlinkSync(join(root, '.claude', 'hooks', 'stop.sh'))
    const r = runDoctor(root, {}, STYLED, { caps: INERT, stream: capture() })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('  \x1b[31m✗\x1b[39m hook shims missing: stop.sh')
    expect(r.stdout).toContain('\x1b[2m    └ run `sofar init --refresh` to (re)install it\x1b[22m')
    expect(r.stdout).toContain('\x1b[31m1 problem found\x1b[39m')
  })

  it('renders warn findings as yellow ⚠ and the warning count yellow', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' }) // v4 with no entry stylesheet → WARN
    const r = runDoctor(root, {}, STYLED, { caps: INERT, stream: capture() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('  \x1b[33m⚠\x1b[39m Tailwind v4 present')
    expect(r.stdout).toContain('\x1b[33m1 warning\x1b[39m')
  })

  it('colors an applied fix green in the summary', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' })
    css(root, 'src/app.css', '@import "tailwindcss";\nbody{}\n')
    const r = runDoctor(root, { fix: true }, STYLED, { caps: INERT, stream: capture() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('\x1b[32m1 fix applied\x1b[39m')
  })

  it('pads ASCII fallback marks (√ / !! / ×) so finding texts stay columnar', () => {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' }) // adds one WARN (with hint) among the OKs
    const ascii: Caps = { color: true, unicode: false, animate: false }
    const r = runDoctor(root, {}, ascii, { caps: INERT, stream: capture() })
    expect(r.stdout).toContain('  \x1b[32m√\x1b[39m  .sofar/bindings.json present') // √ padded to !! width
    expect(r.stdout).toContain('  \x1b[33m!!\x1b[39m Tailwind v4 present')
    expect(r.stdout).toContain('\x1b[2m     `- if you add one') // ascii elbow hint, dim
  })
})

describe('sofar doctor: scan spinner', () => {
  function tailwindRepo(): string {
    const root = tmpRepo()
    runInit(root)
    pkg(root, { tailwindcss: '^4.1.0' })
    css(root, 'src/app.css', '@import "tailwindcss";\n@source not "../.sofar";\nbody{}\n')
    return root
  }

  it('color without animate (piped --color/FORCE_COLOR) stays silent — no static fallback', () => {
    // The upgrade spinner's policy, applied uniformly: anything short of a
    // stderr TTY keeps the stream byte-identical to the unstyled command.
    const out = capture()
    runDoctor(tailwindRepo(), {}, PLAIN, {
      caps: { color: true, unicode: true, animate: false },
      stream: out,
    })
    expect(out.chunks).toEqual([])
  })

  it('animated mode hides the cursor, redraws, and restores on succeed', () => {
    const out = capture()
    runDoctor(tailwindRepo(), {}, PLAIN, {
      caps: { color: true, unicode: true, animate: true },
      stream: out,
    })
    const joined = out.chunks.join('')
    expect(joined.startsWith('\x1b[?25l')).toBe(true)
    expect(joined).toContain('scanning tree for Tailwind entry stylesheets')
    expect(joined).toContain('\x1b[?25h')
    expect(joined.endsWith('\x1b[32m✓\x1b[39m tree scan: 1 Tailwind entry stylesheet\n')).toBe(true)
  })

  it('stays silent on an inert progress channel (piped) — stderr as before', () => {
    const out = capture()
    runDoctor(tailwindRepo(), {}, PLAIN, { caps: INERT, stream: out })
    expect(out.chunks).toEqual([])
  })

  it('never spins for instant checks: no Tailwind v4 → no tree walk → no spinner', () => {
    const root = tmpRepo()
    runInit(root)
    const out = capture()
    runDoctor(root, {}, PLAIN, {
      caps: { color: true, unicode: true, animate: true },
      stream: out,
    })
    expect(out.chunks).toEqual([])
  })
})

/**
 * plan-carry-forward Phase 3 review: this rendered `warnings[0]` alone, so in
 * a record carrying several, every warning after the first was invisible —
 * and a record that already has warnings is exactly where a new one most
 * needs to be read.
 */
describe('sofar doctor: fold warnings are listed, not sampled', () => {
  function warnRecord(root: string, slug: string, count: number): void {
    const dir = join(root, '.sofar', 'initiatives', slug)
    mkdirSync(dir, { recursive: true })
    const lines = Array.from({ length: count }, (_, i) =>
      serializeEvent(
        makeEvent({
          initiative: slug,
          session: 'cli',
          source: 'cli',
          actor: 'agent',
          type: `unknown_type_${i}`,
          payload: {},
        }),
      ),
    )
    writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)
  }

  it('lists every warning up to the cap rather than only the first', () => {
    const root = tmpRepo()
    runInit(root)
    warnRecord(root, 'noisy', 3)
    const r = runDoctor(root, {}, PLAIN, { caps: INERT, stream: capture() })

    expect(r.stdout).toContain('noisy: 3 fold warning(s)')
    for (let i = 0; i < 3; i++) expect(r.stdout).toContain(`unknown_type_${i}`)
    expect(r.stdout).not.toContain('+0 more')
  })

  it('caps the list and says how many it withheld', () => {
    const root = tmpRepo()
    runInit(root)
    warnRecord(root, 'very-noisy', 8)
    const r = runDoctor(root, {}, PLAIN, { caps: INERT, stream: capture() })

    expect(r.stdout).toContain('very-noisy: 8 fold warning(s)')
    expect(r.stdout).toContain('+3 more')
    // The cap is real: past it, nothing is printed.
    expect(r.stdout).not.toContain('unknown_type_5')
  })

  it('styled: the elbow marks the first hint line only, continuations align under it', () => {
    const root = tmpRepo()
    runInit(root)
    warnRecord(root, 'noisy', 2)
    const r = runDoctor(root, {}, STYLED, { caps: INERT, stream: capture() })

    const out = r.stdout.split('\n')
    expect(out.find((l) => l.includes('unknown_type_0'))).toContain('└')
    expect(out.find((l) => l.includes('unknown_type_1'))).not.toContain('└')
  })
})
