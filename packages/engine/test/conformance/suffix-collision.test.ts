import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CASES } from './cases'
import { cleanupScratch, mask, materialize, suffixCollision } from './harness'

const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const sfx = (id: string) => {
  const h = createHash('sha256').update(id, 'utf8').digest()
  const v = (h[0]! << 12) | (h[1]! << 4) | (h[2]! >> 4)
  const a = C.toLowerCase()
  return a[(v >> 15) & 31]! + a[(v >> 10) & 31]! + a[(v >> 5) & 31]! + a[v & 31]!
}
const ulid = (t: number, r: number) => {
  let s = ''
  for (let i = 0, x = t; i < 10; i++, x = Math.floor(x / 32)) s = C[x % 32] + s
  let q = ''
  for (let i = 0, x = r; i < 16; i++, x = Math.floor(x / 32)) q = C[x % 32] + q
  return s + q
}

it('suffixCollision flags a minted suffix an existing decision carries', () => {
  const c = CASES.find((k) => k.name === 'repo.append')!
  const m = materialize('suffix-collision', c.fixture)
  expect(suffixCollision(m)).toEqual([])
  const log = readFileSync(join(m.root, '.sofar/initiatives/felt-cost/events.jsonl'), 'utf8')
  const d3 = log.split('\n').filter((l) => l.includes('"decision_logged"'))[2]!
  const target = sfx(JSON.parse(d3).id)
  let id = ''
  for (let r = 0; ; r++) { id = ulid(Date.now(), r); if (sfx(id) === target) break }
  const text = `minted ${id} and D3·${target}`
  expect(mask(text, m)).toContain('D3·<SFX>')
  expect(suffixCollision(m)).toEqual([target])
  // a fresh materialize forgets the previous run's minted suffixes
  const m2 = materialize('suffix-collision', c.fixture)
  expect(suffixCollision(m2)).toEqual([])
  cleanupScratch()
})
