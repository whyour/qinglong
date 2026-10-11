import { helpText } from '../i18n/help';
import { quietCommand, addFlags } from './options';
export interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  description: string;
  default?: string | boolean;
  required?: boolean;
  choices?: readonly string[];
  integer?: { min: number; max: number };
}

export interface CommandSpec {
  name: string;
  summary: string;
  arguments?: string;
  minimum?: number;
  maximum?: number;
  options?: Record<string, OptionSpec>;
  local?: boolean;
}

export type CommandSurface = 'public' | 'local';

export interface CommandRegistry {
  commands: readonly CommandSpec[];
  aliases: Record<string, string[]>;
  options: Record<string, OptionSpec>;
  surface: CommandSurface;
  validate?: (command: import('./arguments').Invocation) => void;
}
export const globalOptions: Record<string, OptionSpec> = {
  json: {
    type: 'boolean',
    description: 'One JSON result on stdout; diagnostics on stderr',
  },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
};

export function helpFor(
  registry: CommandRegistry,
  spec?: CommandSpec,
  group?: string,
): string {
  const { commands, surface } = registry;
  const selected = spec
    ? [spec]
    : commands.filter(
        (item) =>
          (surface === 'local' ? item.local : !item.local) &&
          (!group || item.name.startsWith(`${group} `)),
      );
  const displayName = (name: string) =>
    surface === 'local' ? name.replace(/^local /, '') : name;
  const program = quietCommand(
    spec ? `ql ${displayName(spec.name)}` : `ql${group ? ' ' + group : ''}`,
  );
  program.description('QingLong 2.x CLI');
  if (spec) {
    if (spec.arguments) program.arguments(spec.arguments);
    program.description(helpText(spec.summary));
  } else {
    for (const item of selected) {
      const child = quietCommand(displayName(item.name)).description(
        helpText(item.summary),
      );
      if (item.arguments) child.arguments(item.arguments);
      program.addCommand(child);
    }
  }
  const options = {
    ...globalOptions,
    ...registry.options,
    ...spec?.options,
  };
  addFlags(
    program,
    Object.fromEntries(
      Object.entries(options).map(([name, option]) => [
        name,
        { ...option, description: helpText(option.description) },
      ]),
    ),
  );
  return program
    .helpInformation()
    .replace(/^Usage:/m, helpText('Usage:'))
    .replace(/^Options:/m, helpText('Options:'))
    .replace(
      /^Commands:/m,
      process.env.QL_LANG === 'en' ? 'Commands:' : '命令：',
    );
}
