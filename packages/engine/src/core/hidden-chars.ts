/**
 * Characters a reader cannot see (r4-fixes B7, `sofar diff`): bidi controls,
 * zero-width and other invisible format characters, Unicode tags, and
 * variation-selector runs.
 *
 * The Rules File Backdoor (Pillar Security, 2025) hid instructions in agent
 * rule files with exactly these, and a record's rules, memories and notes
 * reach the agent's context the same way. A reviewer never sees them: the
 * projections are marked generated, and an events.jsonl line in a diff shows
 * the escaped JSON at best. So the diff names every one, and every surface
 * that renders record text for review prints them as `⟦U+202E⟧`.
 *
 * Three legitimate uses pass: a zero-width joiner inside an emoji sequence, a
 * joiner or non-joiner between letters of a non-Latin script (Persian,
 * Devanagari), and one variation selector after a visible character. A run of
 * selectors (how the 2025 emoji-smuggling payloads carry bytes), one with
 * nothing visible before it, and every selector from the supplement block are
 * flagged. Tag characters pass only as a subdivision flag (🏴 + tags + cancel
 * tag).
 */

export interface HiddenChar {
  /** Code point offset into the text (not UTF-16). */
  at: number
  codePoint: number
}

const NAMES: Readonly<Record<number, string>> = {
  0x00ad: 'SOFT HYPHEN',
  0x061c: 'ARABIC LETTER MARK',
  0x115f: 'HANGUL CHOSEONG FILLER',
  0x1160: 'HANGUL JUNGSEONG FILLER',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER',
  0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0x3164: 'HANGUL FILLER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
  0xffa0: 'HALFWIDTH HANGUL FILLER',
}

function isSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
}

function isTag(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f
}

/** Hidden whatever its neighbours: everything but the joiners and selectors, which depend on context. */
function alwaysHidden(cp: number): boolean {
  if (NAMES[cp] !== undefined) return cp !== 0x200c && cp !== 0x200d
  return (cp >= 0x206a && cp <= 0x206f) || (cp >= 0xfff9 && cp <= 0xfffb) || isTag(cp)
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const LETTER_OR_MARK = /[\p{L}\p{M}]/u

function pictographic(cp: number | undefined): boolean {
  return cp !== undefined && PICTOGRAPHIC.test(String.fromCodePoint(cp))
}

/** A letter or mark outside Latin (U+0000–U+024F): where ZWJ and ZWNJ are spelling, not payload. */
function scriptLetter(cp: number | undefined): boolean {
  return cp !== undefined && cp > 0x24f && LETTER_OR_MARK.test(String.fromCodePoint(cp))
}

function isSkinTone(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff
}

/** The code point before `i`, skipping one emoji presentation selector and skin-tone modifiers. */
function emojiBase(cps: readonly number[], i: number): number | undefined {
  let j = i - 1
  while (j >= 0 && (cps[j] === 0xfe0f || isSkinTone(cps[j]!))) j--
  return j >= 0 ? cps[j] : undefined
}

/** End (exclusive) of a subdivision flag starting at `i` (🏴 + tag letters/digits + cancel tag), or -1. */
function flagSequenceEnd(cps: readonly number[], i: number): number {
  if (cps[i] !== 0x1f3f4) return -1
  let j = i + 1
  while (j < cps.length && cps[j]! >= 0xe0020 && cps[j]! <= 0xe007e) j++
  return j > i + 1 && cps[j] === 0xe007f ? j + 1 : -1
}

export function hiddenChars(text: string): HiddenChar[] {
  const cps = Array.from(text, (c) => c.codePointAt(0)!)
  const found: HiddenChar[] = []
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!
    const flagEnd = flagSequenceEnd(cps, i)
    if (flagEnd !== -1) {
      i = flagEnd - 1
      continue
    }
    if (alwaysHidden(cp)) {
      found.push({ at: i, codePoint: cp })
      continue
    }
    if (cp === 0x200c || cp === 0x200d) {
      const emoji = cp === 0x200d && pictographic(emojiBase(cps, i)) && pictographic(cps[i + 1])
      const script = scriptLetter(cps[i - 1]) && scriptLetter(cps[i + 1])
      if (!emoji && !script) found.push({ at: i, codePoint: cp })
      continue
    }
    if (isSelector(cp)) {
      const prev = cps[i - 1]
      const lone = prev !== undefined && !isSelector(prev) && !alwaysHidden(prev) && !/\s/u.test(String.fromCodePoint(prev))
      if (cp >= 0xe0100 || !lone) found.push({ at: i, codePoint: cp })
    }
  }
  return found
}

/** `U+202E RIGHT-TO-LEFT OVERRIDE` — the name for the common ones, the block for the rest. */
export function codePointLabel(cp: number): string {
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
  const name = NAMES[cp] ?? (isTag(cp) ? 'TAG CHARACTER' : isSelector(cp) ? 'VARIATION SELECTOR' : 'INVISIBLE FORMAT CHARACTER')
  return `${hex} ${name}`
}

/** The text with every hidden character printed as `⟦U+XXXX⟧`, so a reviewer sees where each one sits. */
export function revealHidden(text: string): string {
  const hits = hiddenChars(text)
  if (hits.length === 0) return text
  const cps = Array.from(text)
  for (const hit of hits) cps[hit.at] = `⟦U+${hit.codePoint.toString(16).toUpperCase().padStart(4, '0')}⟧`
  return cps.join('')
}
