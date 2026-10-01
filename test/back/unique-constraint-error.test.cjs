const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const i18n = require.resolve('../../back/shared/i18n');
require.cache[i18n] = {
  id: i18n,
  filename: i18n,
  loaded: true,
  exports: { t: (x) => x },
};
const handler = require('../../back/middlewares/uniqueConstraintError').default;

test('database uniqueness conflicts return 409 without values and preserve existing rows', async () => {
  const db = new Sequelize('sqlite::memory:', { logging: false });
  try {
    const App = db.define('App', {
      name: { type: DataTypes.STRING, unique: true },
    });
    const Env = db.define('Env', {
      name: { type: DataTypes.STRING, unique: 'pair' },
      value: { type: DataTypes.STRING, unique: 'pair' },
    });
    await db.sync();
    const first = await App.create({ name: 'private-app' });
    const second = await App.create({ name: 'other' });
    await Env.create({ name: 'TOKEN', value: 'private-value' });
    const env = await Env.create({ name: 'TOKEN', value: 'other-value' });
    for (const write of [
      () => App.create({ name: first.name }),
      () => second.update({ name: first.name }),
      () => env.update({ value: 'private-value' }),
    ]) {
      await assert.rejects(write, (err) => {
        let status, body;
        handler(
          err,
          {},
          {
            status: (x) => {
              status = x;
              return {
                json: (x) => {
                  body = x;
                },
              };
            },
          },
          () => assert.fail('constraint passed through'),
        );
        assert.equal(status, 409);
        assert.equal(body.code, 409);
        assert.doesNotMatch(
          JSON.stringify(body),
          /private-|TOKEN|INSERT|UPDATE/,
        );
        return true;
      });
    }
    assert.equal((await second.reload()).name, 'other');
    assert.equal((await env.reload()).value, 'other-value');
    const writes = await Promise.allSettled([
      App.create({ name: 'race' }),
      App.create({ name: 'race' }),
    ]);
    assert.equal(writes.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await App.count({ where: { name: 'race' } }), 1);
    const unrelated = new Error('unrelated');
    handler(unrelated, {}, {}, (err) => assert.equal(err, unrelated));
  } finally {
    await db.close();
  }
});
