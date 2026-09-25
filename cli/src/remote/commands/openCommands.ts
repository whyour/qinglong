import { openOperations } from '../api/openOperations';
import type { CommandSpec, OptionSpec } from '../../shared/cli/registry';

const string = (description: string): OptionSpec => ({
  type: 'string',
  description,
});
export const openCommands: CommandSpec[] = openOperations
  .filter((op) => !op.existing)
  .map((op) => {
    const options: Record<string, OptionSpec> = {
      query: string('Query object as JSON, @file or - for stdin'),
      timeout: {
        ...string('Request timeout in seconds'),
        integer: { min: 1, max: 3600 },
      },
    };
    if (op.body && op.body !== 'ids')
      options.data = string('Request body as JSON, @file or - for stdin');
    if (op.upload) options.file = string('Local file to upload');
    if (op.download)
      options.output = {
        ...string('Save response to a new local file'),
        required: true,
      };
    if (
      [
        'task create',
        'task update',
        'subscription create',
        'subscription update',
        'app create',
        'app update',
      ].includes(op.name)
    ) {
      options.name = string('Resource name');
      if (op.name.startsWith('task ')) {
        options.command = string('Command executed by the remote panel');
        options.schedule = string('Cron schedule');
      } else if (op.name.startsWith('subscription ')) {
        for (const key of [
          'type',
          'url',
          'alias',
          'schedule',
          'schedule-type',
          'branch',
          'whitelist',
          'blacklist',
        ])
          options[key] = string(`Subscription ${key}`);
      } else options.scopes = string('Comma-separated application permissions');
    }
    if (op.name.startsWith('app '))
      options['show-secrets'] = {
        type: 'boolean',
        description: 'Explicitly include application credentials in output',
      };
    const params = op.params ?? [];
    return {
      name: op.name,
      summary: `${op.method} /open/${op.path}`,
      arguments:
        op.body === 'ids' ? '<id...>' : params.map((p) => `<${p}>`).join(' '),
      minimum: op.body === 'ids' ? 1 : params.length,
      maximum: op.body === 'ids' ? 10000 : params.length,
      options,
    };
  });
openCommands.push(
  {
    name: 'api request',
    summary: 'Call a registered OpenAPI route',
    arguments: '<method> <path>',
    minimum: 2,
    maximum: 2,
    options: {
      data: string('Request body as JSON, @file or - for stdin'),
      query: string('Query object as JSON, @file or - for stdin'),
      file: string('Local file to upload'),
      output: string('Save response to a new local file'),
      timeout: {
        ...string('Request timeout in seconds'),
        integer: { min: 1, max: 3600 },
      },
      'show-secrets': {
        type: 'boolean',
        description: 'Explicitly include application credentials in output',
      },
    },
  },
  { name: 'api routes', summary: 'List supported OpenAPI routes and commands' },
);
