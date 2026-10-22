const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../helpers/database-fixture.cjs');
const i18n = require.resolve('../../back/shared/i18n');
require.cache[i18n] = {
  id: i18n,
  filename: i18n,
  loaded: true,
  exports: { t: (x) => x },
};
const handler = require('../../back/middlewares/uniqueConstraintError').default;

test('database uniqueness conflicts return 409 without values and preserve existing rows', async () => {
  const { database: db, repository } = await createDatabase({
    after: () => {},
  });
  try {
    const App = repository('App');
    const Env = repository('Env');
    const first = await App.insert({ name: 'private-app' });
    const second = await App.insert({ name: 'other' });
    await Env.insert({ name: 'TOKEN', value: 'private-value' });
    const env = await Env.insert({ name: 'TOKEN', value: 'other-value' });
    for (const write of [
      () => App.insert({ name: first.name }),
      () => App.nativeUpdate({ id: second.id }, { name: first.name }),
      () => Env.nativeUpdate({ id: env.id }, { value: 'private-value' }),
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
    assert.equal((await App.findOne({ id: second.id })).name, 'other');
    assert.equal((await Env.findOne({ id: env.id })).value, 'other-value');
    const writes = await Promise.allSettled([
      App.insert({ name: 'race' }),
      App.insert({ name: 'race' }),
    ]);
    assert.equal(writes.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await App.count({ name: 'race' }), 1);
    const unrelated = new Error('unrelated');
    handler(unrelated, {}, {}, (err) => assert.equal(err, unrelated));
  } finally {
    await db.close();
  }
});
