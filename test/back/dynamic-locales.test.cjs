const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Joi, CelebrateError } = require('celebrate');

const storePath = require.resolve('../../back/shared/store');
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: { shareStore: { setLang: async () => {} } },
};
const { setLang, t } = require('../../back/shared/i18n');
const validationErrors =
  require('../../back/middlewares/validationErrors').default;
const {
  scheduleSchema,
  commonCronSchema,
} = require('../../back/validation/schedule');
const upgrade = require('../../cli/src/internal/maintenance/upgradeArtifacts.cjs');

function responseFor(schema, value, fullResponse = false) {
  const validation = schema.validate(value).error;
  assert.ok(validation);
  const error = new CelebrateError('Validation failed', { celebrated: true });
  error.details.set('body', validation);
  let response;
  const res = {
    status(code) {
      assert.equal(code, 400);
      return this;
    },
    send(body) {
      response = body;
      return this;
    },
  };
  validationErrors(error, {}, res, (err) => {
    throw err;
  });
  return fullResponse ? response : response.validation.body.message;
}

test('compiled validation schemas follow live language changes without altering field paths', () => {
  const schema = Joi.object({
    schedule: scheduleSchema,
    log_name: commonCronSchema.log_name,
  });
  for (const [lang, schedule, empty, logName] of [
    [
      'en',
      'Invalid schedule rule',
      'Schedule rule cannot be empty',
      'Log name cannot exceed 100 characters',
    ],
    ['zh', '无效的定时规则', '定时规则不能为空', '日志名称不能超过100个字符'],
    [
      'en',
      'Invalid schedule rule',
      'Schedule rule cannot be empty',
      'Log name cannot exceed 100 characters',
    ],
  ]) {
    setLang(lang);
    assert.equal(responseFor(schema, { schedule: 'invalid' }), schedule);
    assert.equal(responseFor(schema, { schedule: '' }), empty);
    assert.equal(
      responseFor(schema, { schedule: '* * * * *', log_name: 'x'.repeat(101) }),
      logName,
    );
  }
  setLang('zh');
});

test('cron structure errors switch languages while retaining status and field paths', (t) => {
  const schema = Joi.object(commonCronSchema);
  const empty = ['定时规则不能为空', 'Schedule rule cannot be empty'];
  const string = ['定时规则必须是字符串', 'Schedule rule must be a string'];
  const object = ['额外定时规则必须是对象', 'Extra schedule must be an object'];
  const array = ['额外定时规则必须是数组', 'Extra schedules must be an array'];
  const invalid = ['无效的定时规则', 'Invalid schedule rule'];
  const cases = [
    [{ schedule: undefined }, 'schedule', empty],
    [{ schedule: '' }, 'schedule', empty],
    [{ schedule: 12 }, 'schedule', string],
    [{ schedule: null }, 'schedule', string],
    [{ extra_schedules: [{}] }, 'extra_schedules.0.schedule', empty],
    [
      { extra_schedules: [{ schedule: '' }] },
      'extra_schedules.0.schedule',
      empty,
    ],
    [
      { extra_schedules: [{ schedule: 12 }] },
      'extra_schedules.0.schedule',
      string,
    ],
    [
      { extra_schedules: [{ schedule: null }] },
      'extra_schedules.0.schedule',
      string,
    ],
    [
      { extra_schedules: [{ schedule: 'invalid' }] },
      'extra_schedules.0.schedule',
      invalid,
    ],
    [
      { extra_schedules: [{ schedule: '0 * * * *' }, {}] },
      'extra_schedules.1.schedule',
      empty,
    ],
    ...[null, '0 * * * *', 12, []].map((item) => [
      { extra_schedules: [item] },
      'extra_schedules.0',
      object,
    ]),
    ...['0 * * * *', {}, 12].map((value) => [
      { extra_schedules: value },
      'extra_schedules',
      array,
    ]),
  ];
  t.after(() => setLang('zh', false));
  for (const lang of ['en', 'zh', 'en']) {
    setLang(lang, false);
    for (const [value, field, messages] of cases) {
      const response = responseFor(
        schema,
        {
          command: 'task valid.js',
          schedule: '0 * * * *',
          ...value,
        },
        true,
      );
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.validation.body.message,
        messages[lang === 'zh' ? 0 : 1],
        `${lang}: ${field}`,
      );
      assert.deepEqual(response.validation.body.keys, [field]);
    }
    const multiple = responseFor(
      schema.prefs({ abortEarly: false }),
      {
        command: 'task valid.js',
        schedule: '0 * * * *',
        extra_schedules: [{}, { schedule: 12 }, null],
      },
      true,
    );
    assert.equal(multiple.statusCode, 400);
    assert.equal(
      multiple.validation.body.message,
      [empty, string, object]
        .map((messages) => messages[lang === 'zh' ? 0 : 1])
        .join('. '),
    );
    assert.deepEqual(multiple.validation.body.keys, [
      'extra_schedules.0.schedule',
      'extra_schedules.1.schedule',
      'extra_schedules.2',
    ]);
  }
});

test('history, upload, initialization and proxy messages resolve dynamically and preserve user text', () => {
  const keys = [
    '请先初始化',
    '请先关闭两步验证',
    '仅支持 PNG、JPEG、GIF、WebP、AVIF 图片',
    '历史版本容量不足，无法安全保存',
    '文件已变化，请刷新历史版本后重试',
    'trust proxy 配置格式无效',
  ];
  setLang('en');
  for (const key of keys) assert.doesNotMatch(t(key), /[\u4e00-\u9fff]/);
  assert.equal(t('用户脚本自己的提示'), '用户脚本自己的提示');
  setLang('zh');
  for (const key of keys) assert.equal(t(key), key);
});

test('upgrade verification uses the supplied language and retains artifact details', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-locale-upgrade-'));
  try {
    await fs.writeFile(
      path.join(root, 'build-info.json'),
      JSON.stringify({ version: 1, dirty: true }),
    );
    await assert.rejects(
      upgrade.verifyUpgrade(root, root, { QL_LANG: 'en' }),
      /Invalid or dirty build manifest/,
    );
    await assert.rejects(
      upgrade.verifyUpgrade(root, root, { QL_LANG: 'zh' }),
      /构建清单无效/,
    );
    await fs.writeFile(
      path.join(root, 'build-info.json'),
      JSON.stringify({
        version: 1,
        dirty: false,
        sourceCommit: 'a'.repeat(40),
        lockfileSha256: 'b'.repeat(64),
        files: {},
      }),
    );
    await assert.rejects(
      upgrade.verifyUpgrade(root, root, { QL_LANG: 'en' }),
      /Missing build output: build\/app.js/,
    );
    assert.equal(
      upgrade.upgradeMessage('更新失败: %s', { QL_LANG: 'en' }, '文件名.txt'),
      'Update failed: 文件名.txt',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Shell help switches language and preserves percent characters in script paths', async () => {
  const bash = fs.access('/opt/homebrew/bin/bash').then(
    () => '/opt/homebrew/bin/bash',
    () => 'bash',
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-help-%-'));
  try {
    const source = await fs.readFile(
      path.resolve(__dirname, '../../shell/otask.sh'),
      'utf8',
    );
    const functions = path.join(root, 'functions.sh');
    await fs.writeFile(
      functions,
      source.slice(
        0,
        source.indexOf('\nhandle_task_start "${task_shell_params[@]}"'),
      ),
    );
    for (const lang of ['en', 'zh']) {
      const result = spawnSync(
        await bash,
        [
          '-c',
          '. shell/share.sh; . "shell/lang/$QL_LANG.sh"; . "$2"; dir_scripts="$1"; cmd_task=task; array_scripts=(); array_scripts_name=(); usage',
          '--',
          root,
          functions,
        ],
        {
          cwd: path.resolve(__dirname, '../..'),
          env: { ...process.env, QL_LANG: lang },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(root));
      if (lang === 'en') assert.doesNotMatch(result.stdout, /[\u4e00-\u9fff]/);
      else assert.match(result.stdout, /暂无脚本可以执行/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
