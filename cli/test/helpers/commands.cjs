const parser = require('../../dist/shared/cli/arguments');
const shared = require('../../dist/shared/cli/registry');
const remote = require('../../dist/remote/commands/registry').registry;
const local = require('../../dist/internal/commands/registry').registry;
module.exports = {
  ...shared,
  ...parser,
  commands: [...remote.commands, ...local.commands],
  localOptions: local.options,
  parse: (args, surface = 'public') =>
    parser.parse(args, surface === 'local' ? local : remote),
};
