// Match command text literally: looking up a task must never execute its input.
export function findCronId(crontab: string, command: string): string {
  if (!command) return '';
  for (const line of crontab.split('\n')) {
    const id = /\bID=(\d+)\s/.exec(line);
    if (id && line.includes(command, id.index + id[0].length)) {
      return id[1];
    }
  }
  return '';
}
