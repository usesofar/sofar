/**
 * The agents sofar wires, with no UI attached: cli/agents.ts re-exports them
 * beside the picker, and modules a hook reaches (the wiring journal, the shim
 * self-heal) import them from here so no chain runs into cli/ui.
 */
export const AGENTS = ['claude-code', 'cursor', 'codex'] as const
export type AgentId = (typeof AGENTS)[number]
