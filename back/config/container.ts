export function isInContainer(): boolean {
  return process.env.QL_CONTAINER === 'true';
}

export function maybeSudo(cmd: string): string {
  return isInContainer() ? `sudo ${cmd}` : cmd;
}
