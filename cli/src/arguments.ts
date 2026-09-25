import { openCommands } from './framework/openCommands';
import {
  quietCommand,
  addFlags,
  flagValues,
  isArgumentError,
  assertOptionValues,
} from './framework/options';
import type { CommandSpec } from './framework/registry';
import { fail } from './errors';
import { translate } from './i18n';
import {
  aliases,
  commands,
  globalOptions,
  helpFor,
  localOptions,
  type CommandSurface,
} from './framework/registry';

export interface Invocation {
  name: string;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  json: boolean;
  help?: string;
}

export const help = helpFor();

export function integer(
  value: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  ) {
    fail(translate(process.env, '请输入支持范围内的整数。'), 2);
  }
  return Number(value);
}

export function parse(
  args: string[],
  surface: CommandSurface = 'public',
): Invocation {
  const entry = 'ql';
  const input = [...args];
  // Aliases are vocabulary, while Commander owns command/option parsing.
  let offset = 0;
  while (input[offset] === '--json') offset++;
  if (input[offset] && Object.hasOwn(aliases, input[offset]!))
    input.splice(offset, 1, ...aliases[input[offset]!]!);
  if (input[offset] === 'help') input.splice(offset, 1, '--help');
  const root = quietCommand('ql').enablePositionalOptions();
  root.action(() => {});
  addFlags(root, globalOptions);
  let spec: CommandSpec | undefined;
  let group: string | undefined;
  let values: Invocation['values'] = {};
  let positionals: string[] = [];
  const groups = new Map<string, ReturnType<typeof quietCommand>>();
  for (const item of commands.filter((item) =>
    surface === 'local' ? item.local : !item.local,
  )) {
    const [parentName, action] = item.name.split(' ');
    if (!groups.has(parentName!)) {
      const parent = quietCommand(parentName!).enablePositionalOptions();
      addFlags(parent, globalOptions);
      parent.action(() => {
        group = parentName;
        values = flagValues(parent, globalOptions);
      });
      root.addCommand(parent);
      groups.set(parentName!, parent);
    }
    const schema = {
      ...globalOptions,
      ...(item.local ? localOptions : {}),
      ...item.options,
    };
    const command = quietCommand(action!).argument('[arguments...]');
    addFlags(command, schema);
    command.action(() => {
      spec = item;
      group = parentName;
      values = flagValues(command, schema);
      positionals = command.args;
      const parentValues = flagValues(groups.get(parentName!)!, globalOptions);
      for (const key of ['json', 'help']) {
        if (parentValues[key] && values[key])
          fail(
            translate(process.env, '选项重复，请运行 %s --help。', entry),
            2,
          );
        if (parentValues[key]) values[key] = parentValues[key];
      }
    });
    groups.get(parentName!)!.addCommand(command);
  }
  try {
    assertOptionValues(
      input,
      Object.assign(
        {},
        globalOptions,
        localOptions,
        ...commands.map((item) => item.options),
      ),
    );
    root.parse(input, { from: 'user' });
  } catch (error) {
    if (!isArgumentError(error)) throw error;
    const code = (error as { code: string }).code;
    const unknown =
      code === 'commander.unknownCommand' ||
      (code === 'commander.excessArguments' && !spec);
    fail(
      translate(
        process.env,
        unknown
          ? '未知命令，请运行 %s --help。'
          : '选项未知或缺少选项值，请运行 %s --help。',
        entry,
      ),
      2,
    );
  }
  const inherited = flagValues(root, globalOptions);
  for (const key of ['json', 'help']) {
    if (inherited[key] && values[key])
      fail(translate(process.env, '选项重复，请运行 %s --help。', entry), 2);
    if (inherited[key]) values[key] = inherited[key];
  }
  const helpOnly = !spec;
  const schema = {
    ...globalOptions,
    ...(spec?.local ? localOptions : {}),
    ...spec?.options,
  };
  const result: Invocation = {
    name: spec?.name ?? 'help',
    positionals,
    values,
    json: values.json === true,
  };
  if (helpOnly || values.help)
    return { ...result, help: helpFor(spec, group, surface) };
  if (
    result.positionals.length < (spec?.minimum ?? 0) ||
    result.positionals.length > (spec?.maximum ?? 0)
  )
    fail(translate(process.env, '参数多余或缺少必要参数。'), 2);
  for (const [name, option] of Object.entries(schema)) {
    if (option.required && !values[name])
      fail(translate(process.env, '缺少 --%s。', name), 2);
    if (option.choices && !option.choices.includes(values[name] as string))
      fail(translate(process.env, '--%s 无效。', name), 2);
    if (option.integer && typeof values[name] === 'string')
      integer(values[name] as string, option.integer.min, option.integer.max);
  }
  if (
    !openCommands.some((op) => op.name === result.name) &&
    result.name.startsWith('task ') &&
    result.name !== 'task list'
  )
    integer(result.positionals[0]!);
  if (
    !openCommands.some((op) => op.name === result.name) &&
    result.name.startsWith('subscription ') &&
    result.name !== 'subscription list'
  )
    integer(result.positionals[0]!);
  if (result.name === 'local rmlog') integer(result.positionals[0]!, 0, 365000);
  return result;
}
