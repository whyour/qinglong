const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../dist/arguments');
const {
  commands,
  globalOptions,
  localOptions,
} = require('../dist/framework/registry');
const { runnerOptions } = require('../dist/framework/runnerDefinition');
const { standaloneHelp } = require('../dist/i18n/standalone');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('every registered command and option is discoverable in both help languages', () => {
  const previous = process.env.QL_LANG;
  try {
    for (const language of ['zh', 'en']) {
      process.env.QL_LANG = language;
      for (const surface of ['public', 'local']) {
        const root = parse(['--help'], surface).help;
        for (const spec of commands.filter((spec) =>
          surface === 'local' ? spec.local : !spec.local,
        )) {
          assert.ok(
            root.includes(surface === 'local' ? spec.name.slice(6) : spec.name),
            spec.name,
          );
          const help = parse([...spec.name.split(' '), '--help'], surface).help;
          for (const name of Object.keys({
            ...globalOptions,
            ...(spec.local ? localOptions : {}),
            ...spec.options,
          }))
            assert.ok(help.includes(`--${name}`), `${spec.name}: ${name}`);
        }
      }
      const runner = standaloneHelp('runner', { QL_LANG: language });
      for (const name of Object.keys(runnerOptions))
        assert.ok(runner.includes(`--${name}`), name);
      const internal = spawnSync(
        process.execPath,
        [path.resolve(__dirname, '../dist/ql.js'), '--help', '--json'],
        {
          env: { PATH: process.env.PATH, QL_LANG: language },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.equal(internal.status, 0, internal.stderr);
      const help = JSON.parse(internal.stdout).data.help;
      for (const spec of commands.filter((spec) => spec.local))
        assert.ok(help.includes(spec.name.slice(6)), spec.name);
      assert.doesNotMatch(
        help,
        /auth login|task run|subscription list|app list/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.QL_LANG;
    else process.env.QL_LANG = previous;
  }
});
