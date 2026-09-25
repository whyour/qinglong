const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { createContext, sourceEnvironment } = require('../../dist/internal/runtime/context');
const { executeTask } = require('../../dist/internal/execution/taskRunner');

test('unmodified legacy Shell and TS agree on shell hook state and account modes', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-differential-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  await fs.writeFile(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const context = createContext(
    { root },
    { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, no_tee: 'true' },
  );
  for (const directory of [
    context.paths.dir_shell,
    context.paths.dir_preload,
    context.paths.dir_config,
    context.paths.dir_scripts,
    context.paths.dir_log,
    path.join(root, 'static/build'),
  ])
    await fs.mkdir(directory, { recursive: true });
  for (const name of ['task.sh', 'otask.sh', 'share.sh', 'api.sh', 'env.sh'])
    await fs.copyFile(
      path.resolve(__dirname, '../../../shell', name),
      path.join(context.paths.dir_shell, name),
    );
  await fs.mkdir(path.join(context.paths.dir_shell, 'lang'));
  for (const name of ['zh.sh', 'en.sh'])
    await fs.copyFile(
      path.resolve(__dirname, '../../../shell/lang', name),
      path.join(context.paths.dir_shell, 'lang', name),
    );
  await fs.writeFile(
    path.join(root, 'static/build/token.js'),
    'process.stdout.write("fixture-local-token")',
  );
  await fs.writeFile(
    context.paths.file_config_user,
    'no_tee=true\nconfiguration_function() { printf "function"; }\n',
  );
  await fs.writeFile(context.paths.file_env, 'export ACCOUNTS="one&two"\n');
  await fs.writeFile(context.paths.list_crontab_user, '');
  await fs.writeFile(
    context.paths.file_task_before,
    'state=before\nprintf "before\\n" >> "$TRACE"\n',
  );
  await fs.writeFile(
    context.paths.file_task_after,
    'printf "after:%s:%s\\n" "$state" "$_task_exit_code" >> "$TRACE"\n',
  );
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'fixture.sh'),
    'printf "run:%s:%s:%s\\n" "$ACCOUNTS" "$state" "$(configuration_function)" >> "$TRACE"\nstate=script\n',
  );
  for (const mode of ['now', 'desi', 'conc'])
    await t.test(mode, async () => {
      const legacy = path.join(root, `${mode}-legacy`),
        modern = path.join(root, `${mode}-modern`);
      const args =
        mode === 'now'
          ? ['fixture.sh', 'now']
          : ['fixture.sh', mode, 'ACCOUNTS', '2', '1'];
      execFileSync(
        '/bin/bash',
        [path.join(context.paths.dir_shell, 'task.sh'), ...args],
        {
          cwd: root,
          env: { ...context.env, TRACE: legacy },
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const env = await sourceEnvironment({ ...context.env, TRACE: modern }, [
        context.paths.file_config_user,
      ]);
      const result = await executeTask(
        { ...context, env },
        {
          argv: ['fixture.sh'],
          mode,
          variable: mode === 'now' ? undefined : 'ACCOUNTS',
          selection: mode === 'now' ? undefined : '2 1',
        },
      );
      assert.equal(result.exitCode, 0);
      const oldLines = (await fs.readFile(legacy, 'utf8')).trim().split('\n');
      const newLines = (await fs.readFile(modern, 'utf8')).trim().split('\n');
      assert.equal(oldLines[0], 'before');
      assert.equal(newLines[0], 'before');
      assert.equal(newLines.at(-1), oldLines.at(-1));
      assert.deepEqual(
        newLines.slice(1, -1).sort(),
        oldLines.slice(1, -1).sort(),
      );
    });
  await t.test(
    'Shell failure, explicit exit and EXIT traps preserve hook behavior',
    async () => {
      const cases = [
        { name: 'return', script: 'return 7', code: 7, legacy: 0, after: true },
        { name: 'exit', script: 'exit 7', code: 7, legacy: 7, after: false },
        {
          name: 'errexit',
          script: 'set -e; false',
          code: 1,
          legacy: 1,
          after: false,
        },
        {
          name: 'trap-return',
          script: 'trap \'printf "exit-trap\\n" >> "$TRACE"\' EXIT; return 7',
          code: 7,
          legacy: 0,
          after: true,
          trap: true,
        },
        {
          name: 'trap-exit',
          script: 'trap \'printf "exit-trap\\n" >> "$TRACE"\' EXIT; exit 7',
          code: 7,
          legacy: 7,
          after: false,
          trap: true,
        },
      ];
      await fs.writeFile(context.paths.file_config_user, 'no_tee=true\n');
      await fs.writeFile(
        context.paths.file_task_before,
        'printf "before\\n" >> "$TRACE"\n',
      );
      await fs.writeFile(
        context.paths.file_task_after,
        'printf "after:%s\\n" "$_task_exit_code" >> "$TRACE"\n',
      );
      for (const item of cases) {
        await fs.writeFile(
          path.join(context.paths.dir_scripts, 'failure.sh'),
          item.script + '\n',
        );
        const legacyTrace = path.join(root, `${item.name}-old`);
        const modernTrace = path.join(root, `${item.name}-new`);
        const legacy = spawnSync(
          '/bin/bash',
          [path.join(context.paths.dir_shell, 'task.sh'), 'failure.sh', 'now'],
          {
            cwd: root,
            env: { ...context.env, TRACE: legacyTrace },
            encoding: 'utf8',
            timeout: 15000,
          },
        );
        assert.ifError(legacy.error);
        assert.equal(legacy.status, item.legacy, item.name);
        const env = await sourceEnvironment(
          { ...context.env, TRACE: modernTrace },
          [context.paths.file_config_user],
        );
        const result = await executeTask(
          { ...context, env },
          { argv: ['failure.sh'], mode: 'now' },
        );
        assert.equal(result.exitCode, item.code, item.name);
        const expected = [
          'before',
          ...(item.after ? [`after:${item.code}`] : []),
          ...(item.trap ? ['exit-trap'] : []),
        ];
        for (const file of [legacyTrace, modernTrace])
          assert.deepEqual(
            (await fs.readFile(file, 'utf8')).trim().split('\n'),
            expected,
            `${item.name}: ${file}`,
          );
      }
    },
  );
  await t.test('/dev/null preserves legacy stream routing', async () => {
    await fs.writeFile(
      context.paths.file_task_before,
      'printf "before-out-marker\\n"; printf "before-err-marker\\n" >&2\n',
    );
    await fs.writeFile(
      context.paths.file_task_after,
      'printf "after-out-marker\\n"; printf "after-err-marker\\n" >&2\n',
    );
    await fs.writeFile(
      path.join(context.paths.dir_scripts, 'streams.sh'),
      'printf "child-out-marker\\n"; printf "child-err-marker\\n" >&2\n',
    );
    for (const mode of ['now', 'desi', 'conc']) {
      for (const realtime of [false, true]) {
        await fs.writeFile(
          context.paths.file_config_user,
          `log_name=/dev/null\nno_tee=true\nreal_time=${realtime}\n`,
        );
        const legacy = spawnSync(
          '/bin/bash',
          [
            path.join(context.paths.dir_shell, 'task.sh'),
            'streams.sh',
            mode,
            ...(mode === 'now' ? [] : ['ACCOUNTS', '2', '1']),
          ],
          { cwd: root, env: context.env, encoding: 'utf8', timeout: 15000 },
        );
        assert.ifError(legacy.error);
        assert.equal(legacy.status, 0, legacy.stderr);
        const env = await sourceEnvironment(context.env, [
          context.paths.file_config_user,
        ]);
        let output = '';
        const result = await executeTask(
          { ...context, env },
          {
            argv: ['streams.sh'],
            mode,
            variable: mode === 'now' ? undefined : 'ACCOUNTS',
            selection: mode === 'now' ? undefined : '2 1',
            output: (chunk) => {
              output += chunk;
            },
          },
        );
        assert.equal(result.exitCode, 0);
        assert.equal(result.logPath, '/dev/null');
        const markers = (text) =>
          text.match(/(?:before|after|child)-(?:out|err)-marker/g) ?? [];
        assert.deepEqual(markers(legacy.stdout), []);
        assert.deepEqual(
          markers(output),
          markers(legacy.stderr),
          `${mode}, realtime=${realtime}`,
        );
        assert.ok(markers(output).includes('before-err-marker'));
        assert.equal(
          markers(output).includes('child-err-marker'),
          mode !== 'conc',
        );
      }
    }
  });
});

test('empty ignored-minute settings match legacy random delay at minute zero', async (t) => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../../../shell/otask.sh'),
    'utf8',
  );
  const legacyFunction = source.match(/random_delay\(\) \{[\s\S]*?\n\}/)[0];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-delay-parity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data/scripts'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'data/scripts/fixture.sh'),
    'printf TASK_RAN',
  );
  const OriginalDate = global.Date;
  class MinuteZeroDate extends OriginalDate {
    getMinutes() {
      return 0;
    }
  }
  global.Date = MinuteZeroDate;
  t.after(() => {
    global.Date = OriginalDate;
  });
  for (const ignored of [undefined, '', '   ', '0', ' 30 ']) {
    const env = {
      PATH: process.env.PATH,
      RandomDelay: '1',
      RandomDelayFileExtensions: 'sh',
      ...(ignored === undefined ? {} : { RandomDelayIgnoredMinutes: ignored }),
    };
    const legacy = execFileSync(
      '/bin/bash',
      [
        '-c',
        `${legacyFunction}
date() { printf 0; }
gen_random_num() { printf 0; }
t() { :; }
sleep() { printf DELAYED; }
random_delay fixture.sh
`,
      ],
      { env, encoding: 'utf8' },
    );
    let output = '';
    const result = await executeTask(createContext({ root }, env), {
      argv: ['fixture.sh'],
      output: (chunk) => {
        output += chunk.toString();
      },
    });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /TASK_RAN/);
    assert.equal(
      output.includes('任务随机延迟'),
      legacy.includes('DELAYED'),
      `ignored=${JSON.stringify(ignored)}`,
    );
  }
});

test('random delay follows legacy dispatch for script arguments and executable commands', async (t) => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../../../shell/otask.sh'),
    'utf8',
  );
  const functions = ['random_delay', 'run_normal', 'main']
    .map(
      (name) =>
        source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0],
    )
    .join('\n');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-delay-dispatch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data/scripts'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'data/scripts/fixture.sh'),
    'printf TASK_RAN',
  );
  const env = {
    PATH: process.env.PATH,
    RandomDelay: '1',
    RandomDelayFileExtensions: '',
    RandomDelayIgnoredMinutes: '99',
  };
  for (const args of [
    ['fixture.sh'],
    ['fixture.sh', 'argument'],
    ['fixture.sh', 'now'],
    ['true'],
  ]) {
    const legacy = execFileSync(
      '/bin/bash',
      [
        '-c',
        `${functions}
date() { printf 0; }
gen_random_num() { printf 0; }
t() { :; }
sleep() { printf DELAYED; }
enter_script_workdir() { :; }
run_else() { :; }
which_program=true
main "$@"
`,
        'fixture',
        ...args,
      ],
      { env, encoding: 'utf8' },
    );
    let output = '';
    const parsed = require('../../dist/runner').parseExecution(args);
    const result = await executeTask(createContext({ root }, env), {
      ...parsed.execution,
      output: (chunk) => {
        output += chunk.toString();
      },
    });
    assert.equal(result.exitCode, 0, output);
    assert.equal(
      output.includes('任务随机延迟'),
      legacy.includes('DELAYED'),
      JSON.stringify(args),
    );
  }
});

test('configuration shell options survive the environment bridge for pipeline and glob behavior', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-options-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.sh');
  await fs.writeFile(config, 'set -o pipefail\nshopt -s nullglob\n');
  const probe =
    'false | true; printf "pipeline=%s\\n" "$?"; files=("$EMPTY_DIR"/*.missing); printf "matches=%s\\n" "${#files[@]}"';
  const base = { PATH: process.env.PATH, EMPTY_DIR: root };
  const legacy = execFileSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      '. "$1"; eval "$2"',
      'fixture',
      config,
      probe,
    ],
    { env: base, encoding: 'utf8' },
  );
  const env = await sourceEnvironment(base, [config]);
  assert.ok(env.SHELLOPTS.split(':').includes('pipefail'));
  assert.ok(!env.SHELLOPTS.split(':').includes('allexport'));
  // Bash 3.x cannot import BASHOPTS itself; exercise the actual CLI bridge.
  const execution = await require('../../dist/internal/runtime/process').runProcess(
    'bash', ['--noprofile', '--norc', '-c', probe], { env, capture: true },
  );
  assert.equal(execution.code, 0);
  const modern = execution.stdout;
  assert.equal(modern, legacy);
  assert.match(modern, /pipeline=1/);
  const context = createContext({ root }, { ...env, no_tee: 'true' });
  await fs.mkdir(context.paths.dir_scripts, { recursive: true });
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'pipeline.sh'),
    'false | true\n',
  );
  const result = await executeTask(context, {
    argv: ['pipeline.sh'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 1);
});

test('configuration errexit and nounset retain task and after-hook semantics', async (t) => {
  for (const option of ['errexit', 'nounset']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-option-task-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.sh');
    await fs.writeFile(config, `set -o ${option}\n`);
    const env = await sourceEnvironment({ PATH: process.env.PATH }, [config]);
    assert.ok(env.SHELLOPTS.split(':').includes(option));
    const context = createContext({ root }, { ...env, no_tee: 'true' });
    await fs.mkdir(context.paths.dir_scripts, { recursive: true });
    await fs.mkdir(context.paths.dir_config, { recursive: true });
    const marker = path.join(root, 'after');
    context.env.AFTER_MARKER = marker;
    await fs.writeFile(
      context.paths.file_task_after,
      'printf "%s" "$-" > "$AFTER_MARKER"\n',
    );
    await fs.writeFile(
      path.join(context.paths.dir_scripts, 'options.sh'),
      option === 'errexit'
        ? 'false\nprintf SHOULD_NOT_RUN\n'
        : 'printf "%s" "$QL_UNSET_FIXTURE"\n',
    );
    const result = await executeTask(context, {
      argv: ['options.sh'],
      mode: 'now',
    });
    if (option === 'errexit') {
      assert.equal(result.exitCode, 1);
      await assert.rejects(fs.access(marker));
      assert.doesNotMatch(
        await fs.readFile(
          path.join(context.paths.dir_log, result.logPath),
          'utf8',
        ),
        /SHOULD_NOT_RUN/,
      );
    } else {
      assert.equal(result.exitCode, 0);
      assert.match(await fs.readFile(marker, 'utf8'), /u/);
    }
  }
});

test('later hooks can disable previously enabled shell options without mutating the prior snapshot', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-option-reset-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.sh');
  const hook = path.join(root, 'before.sh');
  await fs.writeFile(config, 'set -o pipefail\nshopt -s nullglob\n');
  await fs.writeFile(hook, 'set +o pipefail\nshopt -u nullglob\n');
  const base = { PATH: process.env.PATH, EMPTY_DIR: root };
  const enabled = await sourceEnvironment(base, [config]);
  const disabled = await sourceEnvironment(enabled, [hook]);
  assert.ok(enabled.SHELLOPTS.split(':').includes('pipefail'));
  assert.ok(!disabled.SHELLOPTS.split(':').includes('pipefail'));
  assert.ok(!disabled.BASHOPTS.split(':').includes('nullglob'));
  const probe =
    'false | true; printf "pipeline=%s\\n" "$?"; files=("$EMPTY_DIR"/*.missing); printf "matches=%s\\n" "${#files[@]}"';
  const legacy = execFileSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      '. "$1"; . "$2"; eval "$3"',
      'fixture',
      config,
      hook,
      probe,
    ],
    { env: base, encoding: 'utf8' },
  );
  const modern = execFileSync('bash', ['--noprofile', '--norc', '-c', probe], {
    env: disabled,
    encoding: 'utf8',
  });
  assert.equal(modern, legacy);
  assert.equal(modern, 'pipeline=0\nmatches=1\n');
  const context = createContext({ root }, { ...enabled, no_tee: 'true' });
  await fs.mkdir(context.paths.dir_scripts, { recursive: true });
  await fs.mkdir(context.paths.dir_config, { recursive: true });
  await fs.copyFile(hook, context.paths.file_task_before);
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'pipeline.sh'),
    'false | true\n',
  );
  await fs.writeFile(
    context.paths.file_task_after,
    'false | true; printf "%s" "$?" > "$AFTER_RESULT"\n',
  );
  context.env.AFTER_RESULT = path.join(root, 'after-result');
  const result = await executeTask(context, {
    argv: ['pipeline.sh'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(context.env.AFTER_RESULT, 'utf8'), '0');
});

test('disabled default shell options stay disabled across configuration and task bridges', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-default-options-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.sh');
  await fs.writeFile(config, 'set +o braceexpand\nshopt -u extquote\n');
  const env = await sourceEnvironment({ PATH: process.env.PATH }, [config]);
  const refreshed = await sourceEnvironment(env, []);
  assert.ok(!refreshed.SHELLOPTS.split(':').includes('braceexpand'));
  assert.ok(!refreshed.BASHOPTS.split(':').includes('extquote'));
  const context = createContext({ root }, { ...refreshed, no_tee: 'true' });
  await fs.mkdir(context.paths.dir_scripts, { recursive: true });
  const script =
    'printf "%s\\n" {a,b}; shopt -q extquote && printf WRONG; true\n';
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'options.sh'),
    script,
  );
  const legacy = execFileSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      '. "$1"; eval "$2"',
      'fixture',
      config,
      script,
    ],
    { env: { PATH: process.env.PATH }, encoding: 'utf8' },
  );
  assert.equal(legacy, '{a,b}\n');
  const result = await executeTask(context, {
    argv: ['options.sh'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 0);
  const log = await fs.readFile(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.ok(log.includes(legacy));
  assert.doesNotMatch(log, /WRONG/);
});
