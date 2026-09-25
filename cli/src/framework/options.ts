import { Command, CommanderError, Option } from './commander';
import { fail } from '../errors';
import { translate } from '../i18n';

export interface FlagDefinition {
  type: 'string' | 'boolean';
  short?: string;
  description?: string;
  default?: string | boolean;
}

export function quietCommand(name: string): Command {
  return new Command(name)
    .helpOption(false)
    .addHelpCommand(false)
    .exitOverride()
    .configureOutput({ writeOut() {}, writeErr() {} });
}

export function addFlags(
  command: Command,
  schema: Record<string, FlagDefinition>,
  rejectDuplicates = true,
): void {
  const seen = new Set<string>();
  for (const [name, definition] of Object.entries(schema)) {
    const option = new Option(
      `${definition.short ? `-${definition.short}, ` : ''}--${name}${definition.type === 'string' ? ' <value>' : ''}`,
      definition.description,
    );
    // --no-startup is a positive application flag, not Commander negation.
    option.negate = false;
    if (definition.default !== undefined) option.default(definition.default);
    command.addOption(option);
    command.on(`option:${option.name()}`, () => {
      if (rejectDuplicates && seen.has(name))
        fail(translate(process.env, '选项重复，请运行 %s --help。', 'ql'), 2);
      seen.add(name);
    });
  }
}

export function flagValues(
  command: Command,
  schema: Record<string, FlagDefinition>,
): Record<string, string | boolean | undefined> {
  const raw = command.opts();
  const result: Record<string, string | boolean | undefined> = {};
  for (const name of Object.keys(schema)) {
    const option = command.options.find(item => item.long === `--${name}`)!;
    if (raw[option.attributeName()] !== undefined)
      result[name] = raw[option.attributeName()];
  }
  return result;
}

// Commander permits --url --json as a string value. Preserve the previous
// strict contract: leading-dash values need --url=--json (or -p-1).
export function assertOptionValues(
  args: string[],
  schema: Record<string, FlagDefinition>,
  passThrough = false,
): void {
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === '--') break;
    if (!token.startsWith('-') || token === '-') {
      if (passThrough) break;
      continue;
    }
    let expectsValue = false;
    if (token.startsWith('--')) {
      if (!token.includes('=')) expectsValue = schema[token.slice(2)]?.type === 'string';
    } else {
      for (let offset = 1; offset < token.length; offset++) {
        const definition = Object.values(schema).find(option => option.short === token[offset]);
        if (!definition) break;
        if (definition.type === 'string') {
          expectsValue = offset === token.length - 1;
          break;
        }
      }
    }
    if (expectsValue) {
      const next = args[++index];
      if (next === undefined || (next.length > 1 && next.startsWith('-')))
        throw new CommanderError(2, 'commander.optionMissingArgument', 'Missing option value');
    }
  }
}

export function parseFlags(
  args: string[],
  schema: Record<string, FlagDefinition>,
  options: { passThrough?: boolean; rejectDuplicates?: boolean } = {},
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  const command = quietCommand('ql').allowExcessArguments(true);
  if (options.passThrough) command.passThroughOptions();
  addFlags(command, schema, options.rejectDuplicates ?? true);
  assertOptionValues(args, schema, options.passThrough);
  command.parse(args, { from:'user' });
  return { values:flagValues(command, schema), positionals:command.args };
}

export function isArgumentError(error: unknown): boolean {
  return error instanceof CommanderError;
}
