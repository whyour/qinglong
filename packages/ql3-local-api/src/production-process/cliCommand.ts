export type LocalApiCliCommand = Readonly<{
  configFilePath: string;
  mode: 'api' | 'cutover_probe';
}>;

export function localApiCliFailureFact(
  error: unknown,
): Readonly<Record<string, unknown>> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-local-api',
    level: 'error',
    event: 'process_failed',
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

export function parseLocalApiCliCommand(
  argv: readonly string[],
): LocalApiCliCommand | null {
  if (argv.length === 2 && argv[0] === '--config' && argv[1]) {
    return Object.freeze({
      configFilePath: argv[1],
      mode: 'api' as const,
    });
  }
  if (
    argv.length === 3 &&
    argv[0] === '--cutover-probe' &&
    argv[1] === '--config' &&
    argv[2]
  ) {
    return Object.freeze({
      configFilePath: argv[2],
      mode: 'cutover_probe' as const,
    });
  }
  return null;
}
