const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadModule = require('../helpers/load-security-module.cjs');

const { commonCronSchema } = loadModule(
  path.join(__dirname, '../../back/validation/schedule.ts'),
  { '../config': { logPath: '/ql/data/log/' } },
);

// Execute the actual form validator without mounting the entire task modal.
const source = ts.createSourceFile(
  'modal.tsx',
  fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/modal.tsx'),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let validateForm;
function visit(node) {
  if (
    ts.isJsxOpeningElement(node) &&
    node.attributes.properties.some(
      (attr) =>
        ts.isJsxAttribute(attr) &&
        attr.name.text === 'name' &&
        attr.initializer?.text === 'log_name',
    )
  ) {
    const rules = node.attributes.properties.find(
      (attr) => ts.isJsxAttribute(attr) && attr.name.text === 'rules',
    );
    const validator = rules.initializer.expression.elements[0].properties.find(
      (property) => property.name.text === 'validator',
    ).initializer;
    const { outputText } = ts.transpileModule(
      `const validate = ${validator.getText(source)};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2017 } },
    );
    validateForm = new Function('intl', `${outputText}\nreturn validate;`)({
      get: (key) => key,
    });
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(typeof validateForm, 'function');

test('form and API accept Chinese log names and existing supported names', async () => {
  for (const value of [
    '',
    null,
    undefined,
    '测试',
    '任务_測試-2026.log',
    '分组/每日签到/',
    '𠮷/扩展汉字',
    'legacy_name-123.log',
    'legacy/path/',
    '/ql/data/log/中文日志',
    '/dev/null',
    '中'.repeat(100),
  ]) {
    await validateForm(undefined, value);
    assert.equal(
      commonCronSchema.log_name.validate(value).error,
      undefined,
      value,
    );
  }
});

test('form and API still reject unsafe relative names and excessive length', async () => {
  for (const value of [
    '.',
    '..',
    '../测试',
    '测试/../日志',
    '测试/./日志',
    '测试//日志',
    '测试\\日志',
    '测试 日志',
    '测试;echo',
    '测试$(id)',
    '测试`id`',
    '测试\n日志',
    '测试\0日志',
    '测试😀',
    '中'.repeat(101),
  ]) {
    await assert.rejects(validateForm(undefined, value), undefined, value);
    assert.ok(commonCronSchema.log_name.validate(value).error, value);
  }
});

test('API restricts absolute log paths to the configured directory or /dev/null', () => {
  for (const value of [
    '/tmp/测试',
    '/ql/data/log/../测试',
    '/ql/data/log-other/测试',
  ]) {
    const { error } = commonCronSchema.log_name.validate(value);
    assert.equal(error.details[0].type, 'string.unsafePath', value);
  }
});
