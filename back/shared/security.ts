/**
 * Centralized input-hardening helpers used to neutralize command injection,
 * argument injection and config-file injection across the backend.
 *
 * The task runner legitimately executes user scripts, but data fields such as
 * git URLs, branches, dependency names and proxies are NOT meant to be code.
 * These helpers keep such values from breaking out of the shell commands /
 * config files they are interpolated into.
 */
import crypto from 'crypto';

/**
 * POSIX single-quote escaping. Wraps a value so it is passed to the shell as a
 * single literal argument, neutralizing $(), backticks, ;, |, &, redirects,
 * whitespace and newlines.
 */
export function shellEscape(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/** Characters that enable shell command injection / argument chaining. */
const SHELL_METACHAR = /[;&|`$<>(){}\[\]'"\\!\n\r\t ]/;

/**
 * Validate a package/dependence name before it is interpolated into an
 * install/uninstall/version command (pnpm/pip/apk/apt). Throws on anything that
 * could break out of the command or inject an extra argument.
 */
export function assertSafeDependenceName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n || n.length > 214 || SHELL_METACHAR.test(n) || n.startsWith('-')) {
    throw new Error('Invalid dependence name');
  }
  return n;
}

/**
 * Joi-compatible patterns for subscription fields that flow into shell commands
 * and ssh config files. They block shell metacharacters / newlines while still
 * permitting legitimate values.
 */
export const SUBSCRIPTION_PATTERNS = {
  // git/http(s)/ssh url: no whitespace or shell metacharacters, must not start with '-'
  url: /^(?!-)[^\s;&|`$<>(){}'"\\]+$/,
  // git ref: word chars, dots, slashes, dashes
  branch: /^[\w.\/-]*$/,
  // space/comma separated bare file extensions
  extensions: /^[A-Za-z0-9 ,]*$/,
  // host:port (consumed by the nc ProxyCommand) or empty
  proxy: /^([\w.\-]+:\d+)?$/,
  // regex filters: forbid line breaks and command-substitution chars, keep regex metachars
  filter: /^[^\r\n`$\\]*$/,
};

/**
 * Constant-time string comparison for tokens / secrets / passwords. Both inputs
 * are hashed to a fixed length first so timingSafeEqual never throws on length
 * mismatch and the comparison does not leak length via timing.
 */
export function safeCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Reject values that are dangerous when written verbatim into an ssh config file. */
export function isSafeSshConfigValue(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  return !/[\r\n;&|`$<>()'"\\]/.test(String(value));
}
