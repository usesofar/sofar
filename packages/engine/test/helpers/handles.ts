/**
 * Decision handles print check-suffixed on every agent-facing line (r4-fixes
 * U5): `D12·k3fz`. `bare` drops the suffixes so an assertion about the rest of
 * a line reads as before; the suffix itself is pinned where it is the point
 * (test/handle-render.test.ts, the conformance and render-parity goldens).
 */
export const bare = (text: string): string => text.replace(/(D[1-9][0-9]*)·[0-9a-hjkmnp-tv-z]{4}/g, '$1')
