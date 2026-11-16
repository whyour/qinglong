// Read literal shell words only. Never expand or execute a command to derive a
// path. Adjacent quoted/unquoted fragments belong to the same argument.
function words(command: string): string[] {
  const result: string[] = [];
  let value = '', quote = '', active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote && c === quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; active = true; continue; }
    if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) return [];
      if (quote === '"' && !/[$`"\\\n]/.test(next)) value += '\\';
      if (next !== '\n') { value += next; active = true; }
      continue;
    }
    if (!quote && /[;&|<>()\n]/.test(c)) break;
    if (!quote && /\s/.test(c)) {
      if (active) result.push(value);
      value = ''; active = false; continue;
    }
    if (!active && !quote && c === '#') break;
    value += c; active = true;
  }
  if (quote) return [];
  if (active) result.push(value);
  return result;
}

export function cronOperand(command: string, taskOnly = false): string | undefined {
  const args = words(command.trim());
  if (args[0] === 'task') args.shift();
  else if (taskOnly && args[0] === 'ql') return;
  while (args[0] === '-l' || args[0] === '-m') {
    if (args.shift() === '-m') args.shift();
  }
  if (args.length > 1 && /^(?:.*\/)?(?:node|python3?|bash|sh|ts-node(?:-transpile-only)?)$/.test(args[0])) args.shift();
  return args[0];
}
