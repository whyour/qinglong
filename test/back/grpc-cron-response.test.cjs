const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { Sequelize, DataTypes, Model } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const { CronResponse } = load('back/protos/api.ts');
const source = fs.readFileSync('back/schedule/api.ts', 'utf8');
const start = source.indexOf('const normalizeCronData =');
const end = source.indexOf('export const getCronDetail', start);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const normalize = new Function('Model', `${code}\nreturn normalizeCronData;`)(
  Model,
);

test('gRPC cron response preserves Sequelize model fields through protobuf serialization', async (t) => {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const Cron = db.define('Cron', {
    name: DataTypes.STRING,
    command: DataTypes.STRING,
    schedule: DataTypes.STRING,
    labels: DataTypes.JSON,
    extra_schedules: DataTypes.JSON,
  });
  const model = Cron.build({
    id: 7,
    name: 'smoke',
    command: 'true',
    schedule: '* * * * *',
    labels: ['test'],
  });
  const decoded = CronResponse.decode(
    CronResponse.encode({ code: 200, data: normalize(model) }).finish(),
  );
  assert.equal(decoded.data.id, 7);
  assert.equal(decoded.data.name, 'smoke');
  assert.equal(decoded.data.command, 'true');
  assert.deepEqual(decoded.data.labels, ['test']);
  assert.deepEqual(decoded.data.extra_schedules, []);
});

test('legacy plain cron rows normalize absent repeated fields', () => {
  const decoded = CronResponse.decode(
    CronResponse.encode({
      code: 200,
      data: normalize({ id: 8, labels: null, extra_schedules: null }),
    }).finish(),
  );
  assert.equal(decoded.data.id, 8);
  assert.deepEqual(decoded.data.labels, []);
  assert.deepEqual(decoded.data.extra_schedules, []);
  assert.equal(normalize(null), undefined);
});
