// A `sofar drive` verification inherits the driver's environment, and a
// FORCE_COLOR there outranks the piped-stdout check (cli/ui/caps.ts), so every
// CLI a test spawns with `...process.env` renders ANSI and the plain-output
// assertions fail (21 of them, 2026-09-29). Colour is opt-in per test: the
// ones that exercise it set FORCE_COLOR on the child they spawn.
delete process.env.FORCE_COLOR
