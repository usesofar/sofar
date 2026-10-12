/** A hold with the owing session's id dropped (felt-latency L4), for tests that pin the rest of its text. */
export const unnamed = (stderr: string | undefined): string | undefined => stderr?.replace(/ with session_id \S+/g, '')
