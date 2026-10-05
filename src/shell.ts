/**
 * Quote a value for safe interpolation into a shell command, mirroring
 * Python's shlex.quote. Everything the executor receives through exec
 * fallbacks (rm, mv, test) goes through this first: user-controlled paths
 * must never be able to inject shell syntax.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
