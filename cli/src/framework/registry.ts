import { helpText } from '../i18n/help';
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

const positiveId = '<id>';
export const commands: readonly CommandSpec[] = [
  {
    name: 'auth login',
    summary: 'Authenticate with a remote panel application',
    options: {
      url: {
        type: 'string',
        description: 'Panel URL including optional base path',
        required: true,
      },
    },
  },
  {
    name: 'auth status',
    summary: 'Verify authentication and resource permission',
    options: {
      scope: {
        type: 'string',
        description: 'Permission to check',
        default: 'crons',
        choices: ['crons', 'subscriptions'],
      },
    },
  },
  {
    name: 'auth logout',
    summary: 'Remove local credentials (does not revoke the server token)',
  },
  {
    name: 'task list',
    summary: 'List remote tasks',
    options: {
      search: { type: 'string', description: 'Search task name or command' },
      page: {
        type: 'string',
        short: 'p',
        description: 'Page number',
        default: '1',
        integer: { min: 1, max: Number.MAX_SAFE_INTEGER },
      },
      size: {
        type: 'string',
        description: 'Page size',
        default: '50',
        integer: { min: 1, max: 200 },
      },
    },
  },
  ...['get', 'run', 'stop'].map(
    (action): CommandSpec => ({
      name: `task ${action}`,
      summary: `${action} a remote task by ID`,
      arguments: positiveId,
      minimum: 1,
      maximum: 1,
    }),
  ),
  {
    name: 'task logs',
    summary: 'Read the latest task log',
    arguments: positiveId,
    minimum: 1,
    maximum: 1,
    options: {
      tail: {
        type: 'string',
        short: 'n',
        description: 'Last N lines',
        default: '200',
        integer: { min: 1, max: 10000 },
      },
    },
  },
  {
    name: 'subscription list',
    summary: 'List panel subscriptions',
    options: {
      search: { type: 'string', description: 'Search subscriptions' },
    },
  },
  ...['get', 'run', 'stop', 'enable', 'disable'].map(
    (action): CommandSpec => ({
      name: `subscription ${action}`,
      summary: `${action} a panel subscription by ID`,
      arguments: '<id>',
      minimum: 1,
      maximum: 1,
    }),
  ),
  {
    name: 'subscription logs',
    summary: 'Read latest subscription log',
    arguments: '<id>',
    minimum: 1,
    maximum: 1,
    options: {
      tail: {
        type: 'string',
        short: 'n',
        description: 'Last N lines',
        default: '200',
        integer: { min: 1, max: 10000 },
      },
    },
  },
  {
    name: 'local rmlog',
    summary: 'Remove expired logs not referenced by a task',
    arguments: '<days>',
    minimum: 1,
    maximum: 1,
    local: true,
  },
  {
    name: 'local extra',
    summary: 'Execute the user extra.sh hook',
    local: true,
  },
  {
    name: 'local repair-config',
    summary: 'Restore missing configuration templates and runtime directories',
    local: true,
  },
  {
    name: 'local check',
    summary:
      'Install runtime dependencies, repair files, diagnose and reload services',
    local: true,
  },
  {
    name: 'local bot',
    summary: 'Install dependencies and start the optional local Telegram bot',
    local: true,
  },
  {
    name: 'local start',
    summary: 'Install runtime prerequisites and start nginx and panel services',
    local: true,
    options: {
      'no-startup': {
        type: 'boolean',
        description: 'Skip OS boot registration (for containers)',
      },
      reload: {
        type: 'boolean',
        description:
          'Restart services without installing packages or starting optional hooks',
      },
    },
  },
  {
    name: 'local reload',
    summary: 'Restart local services or apply staged system/data files',
    local: true,
    options: {
      target: {
        type: 'string',
        description: 'Reload target',
        default: 'services',
        choices: ['services', 'system', 'data'],
      },
    },
  },
  {
    name: 'local update',
    summary: 'Stage and apply a local panel upgrade',
    local: true,
    options: {
      mirror: {
        type: 'string',
        description: 'Archive source',
        default: 'github',
        choices: ['github', 'gitee'],
      },
      'download-only': {
        type: 'boolean',
        description:
          'Prepare upgrade without replacing files or restarting services',
      },
    },
  },
  ...['resetlet', 'resettfa', 'resetpwd', 'resetname'].map(
    (action): CommandSpec => ({
      name: `local ${action}`,
      summary: `Local panel ${action}`,
      arguments: ['resetpwd', 'resetname'].includes(action)
        ? '<value>'
        : undefined,
      minimum: ['resetpwd', 'resetname'].includes(action) ? 1 : 0,
      maximum: ['resetpwd', 'resetname'].includes(action) ? 1 : 0,
      local: true,
    }),
  ),
];

export const aliases: Record<string, string[]> = {
  login: ['auth', 'login'],
  rmlog: ['local', 'rmlog'],
  extra: ['local', 'extra'],
  'repair-config': ['local', 'repair-config'],
  check: ['local', 'check'],
  bot: ['local', 'bot'],
  start: ['local', 'start'],
  reload: ['local', 'reload'],
  update: ['local', 'update'],
  resetlet: ['local', 'resetlet'],
  resettfa: ['local', 'resettfa'],
  resetpwd: ['local', 'resetpwd'],
  resetname: ['local', 'resetname'],
};

export const globalOptions: Record<string, OptionSpec> = {
  json: {
    type: 'boolean',
    description: 'One JSON result on stdout; diagnostics on stderr',
  },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
};

export const localOptions: Record<string, OptionSpec> = {
  root: {
    type: 'string',
    description: 'Installed panel root (defaults to QL_DIR)',
  },
  'data-dir': {
    type: 'string',
    description: 'Panel data directory (defaults to QL_DATA_DIR)',
  },
};

export function helpFor(
  spec?: CommandSpec,
  group?: string,
  surface: CommandSurface = 'public',
): string {
  const selected = spec
    ? [spec]
    : commands.filter(
        (item) =>
          (surface === 'local' ? item.local : !item.local) &&
          (!group || item.name.startsWith(`${group} `)),
      );
  const binary = 'ql';
  const displayName = (name: string) =>
    surface === 'local' ? name.replace(/^local /, '') : name;
  const lines = [
    'QingLong 2.x CLI',
    '',
    spec
      ? `${helpText('Usage:')} ${binary} ${displayName(spec.name)} ${
          spec.arguments ?? ''
        } [options]`
      : `${helpText('Usage:')} ${binary} ${group ?? '<command>'} [options]`,
    '',
    ...selected.map(
      (item) =>
        `  ${(displayName(item.name) + ' ' + (item.arguments ?? '')).padEnd(
          30,
        )} ${helpText(item.summary)}`,
    ),
  ];
  const options = {
    ...globalOptions,
    ...(spec?.local ? localOptions : {}),
    ...spec?.options,
  };
  lines.push(
    '',
    helpText('Options:'),
    ...Object.entries(options).map(
      ([name, option]) =>
        `  ${`${option.short ? `-${option.short}, ` : ''}--${name}${
          option.type === 'string' ? ' <value>' : ''
        }`.padEnd(27)} ${helpText(option.description)}${
          option.default !== undefined
            ? ` (${helpText('default:')} ${option.default})`
            : ''
        }`,
    ),
  );
  if (!spec)
    lines.push(
      '',
      surface === 'public'
        ? helpText('Alias: login = auth login.')
        : helpText('Local operator commands require an installed panel.'),
    );
  return lines.join('\n');
}
