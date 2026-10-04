import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mayWriteCommand } from '../src/core/derived'

/**
 * r3-fixes 2.13 (D23): which shell commands may write a file the hooks never
 * capture — the one reason Stop's test gate asks git. The table is shared
 * with the Rust core (crates/sofar-core/tests/fixtures/js-may-write.json), so
 * both engines classify every case alike.
 */
const cases = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'crates', 'sofar-core', 'tests', 'fixtures', 'js-may-write.json'), 'utf8'),
) as Array<{ cmd: string; may_write: boolean }>

describe('mayWriteCommand (D23)', () => {
  it.each(cases)('$cmd → $may_write', ({ cmd, may_write }) => {
    expect(mayWriteCommand(cmd)).toBe(may_write)
  })
})
