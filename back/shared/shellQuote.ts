/** Quote one literal POSIX shell argument, including quotes and substitutions. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid shell argument');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
