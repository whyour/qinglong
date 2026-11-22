import { openCommands } from './openCommands';
import { openOperations } from '../api/openOperations';
import type { CommandSpec, CommandRegistry } from '../../shared/cli/registry';
import { integer } from '../../shared/cli/arguments';
import { validTriggerId } from '../trigger';
import { fail } from '../../shared/errors';
import { translate } from '../../shared/i18n/index';
const positiveId = '<id>';
const waitTimeout = {
  type: 'string' as const,
  description: 'Maximum wait in seconds (default 300; does not stop the task)',
  default: '300',
  integer: { min: 1, max: 86400 },
};
const triggerOption = {
  type: 'string' as const,
  description: 'Exact trigger ID returned by task run',
};
export const commands: readonly CommandSpec[] = [
  ...openCommands,
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
        choices: [
          ...new Set(openOperations.map((op) => op.path.split('/')[0]!)),
          'envs:read',
          'configs:read',
          'scripts:read',
          'crons:read',
          'subscriptions:read',
          'dependencies:read',
          'logs:read',
          'dashboard:read',
        ].filter((scope) => !['auth', 'update'].includes(scope)),
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
  ...['get', 'stop'].map(
    (action): CommandSpec => ({
      name: `task ${action}`,
      summary: `${action} a remote task by ID`,
      arguments: positiveId,
      minimum: 1,
      maximum: 1,
    }),
  ),
  {
    name: 'task run',
    summary: 'run a remote task by ID',
    arguments: positiveId,
    minimum: 1,
    maximum: 1,
    options: {
      wait: {
        type: 'boolean',
        description: 'Wait for this run to finish successfully',
      },
      timeout: { ...waitTimeout, default: undefined },
    },
  },
  {
    name: 'task wait',
    summary: 'Wait for an existing trigger without running the task again',
    arguments: positiveId,
    minimum: 1,
    maximum: 1,
    options: {
      'trigger-id': { ...triggerOption, required: true },
      timeout: waitTimeout,
    },
  },
  {
    name: 'task logs',
    summary: 'Read the latest task log',
    arguments: positiveId,
    minimum: 1,
    maximum: 1,
    options: {
      'trigger-id': triggerOption,
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
];
export const registry: CommandRegistry = {
  commands,
  aliases: { login: ['auth', 'login'] },
  options: {},
  surface: 'public',
  validate(command) {
    if (
      command.name === 'task run' &&
      command.values.timeout !== undefined &&
      !command.values.wait
    ) {
      fail(translate(process.env, '--timeout 需要与 --wait 一起使用。'), 2);
    }
    if (
      command.values['trigger-id'] !== undefined &&
      !validTriggerId(command.values['trigger-id'])
    ) {
      fail(translate(process.env, '触发 ID 无效。'), 2);
    }
    if (
      !openCommands.some((op) => op.name === command.name) &&
      /^(task|subscription) /.test(command.name) &&
      !command.name.endsWith(' list')
    )
      integer(command.positionals[0]!);
  },
};
