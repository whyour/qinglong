import type {
  CommandSpec,
  CommandRegistry,
  OptionSpec,
} from '../../shared/cli/registry';
import { integer } from '../../shared/cli/arguments';
export const commands: readonly CommandSpec[] = [
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

export const registry: CommandRegistry = {
  commands,
  aliases,
  options: localOptions,
  surface: 'local',
  validate(command) {
    if (command.name === 'local rmlog')
      integer(command.positionals[0]!, 0, 365000);
  },
};
