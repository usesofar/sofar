// Reference implementation of roadmap steps 1 and 9, used only by `run.mjs --self-test`
// to prove step9-check.mjs is satisfiable. Never copied into a measured cell.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const DB = process.env.PANTRY_DB || './pantry.json'
const load = () => (existsSync(DB) ? JSON.parse(readFileSync(DB, 'utf8')) : { items: {} })
const save = (s) => writeFileSync(DB, `${JSON.stringify(s, null, 2)}\n`)
const fail = (m) => {
  console.error(m)
  process.exit(1)
}
const listText = (s) => Object.keys(s.items).sort().map((k) => `${k} ${s.items[k]}`)
const HELP = 'commands: add <item> x<n>; how much <item>; use <item> x<n>; list; forget <item>'

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'add') {
  const [item, n] = rest
  if (!item || !/^[1-9]\d*$/.test(n ?? '')) fail('usage: add <item> <n>')
  const s = load()
  const k = item.toLowerCase()
  s.items[k] = (s.items[k] ?? 0) + Number(n)
  save(s)
} else if (cmd === 'list') {
  for (const l of listText(load())) console.log(l)
} else if (cmd === 'say') {
  const text = rest.join(' ').trim()
  const s = load()
  let reply = HELP
  let changed = false
  let m
  if ((m = /^add (\S+) x(\d+)$/.exec(text))) {
    const k = m[1].toLowerCase()
    s.items[k] = (s.items[k] ?? 0) + Number(m[2])
    reply = `added ${Number(m[2])} ${k}, now ${s.items[k]}`
    changed = true
  } else if ((m = /^how much (\S+)$/.exec(text))) {
    const k = m[1].toLowerCase()
    reply = k in s.items ? `${k}: ${s.items[k]}` : `${k}: none`
  } else if ((m = /^use (\S+) x(\d+)$/.exec(text))) {
    const k = m[1].toLowerCase()
    s.items[k] = Math.max(0, (s.items[k] ?? 0) - Number(m[2]))
    reply = `used ${Number(m[2])} ${k}, now ${s.items[k]}`
    changed = true
  } else if (text === 'list') {
    const lines = listText(s)
    reply = lines.length ? lines.join('; ') : 'pantry is empty'
  } else if ((m = /^forget (\S+)$/.exec(text))) {
    const k = m[1].toLowerCase()
    if (k in s.items) {
      delete s.items[k]
      reply = `forgot ${k}`
      changed = true
    } else reply = `nothing called ${k}`
  }
  if (changed) save(s)
  console.log(JSON.stringify({ reply, changed }))
} else fail('usage: node pantry.js add <item> <n> | list | say "<text>"')
