const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { ScheduleType } = require('../../back/interface/schedule');

test('system and node modes route extended cron once and keep portable rules in crontab', async () => {
  const source = fs.readFileSync('back/services/cron.ts', 'utf8');
  const begin = source.indexOf('  private isNodeCron(');
  const end = source.indexOf('  private async getLogName', begin);
  const saveBegin = source.indexOf('  private async setCrontab(');
  const saveEnd = source.indexOf('  public importCrontab(', saveBegin);
  const js = ts.transpileModule(`class Fixture {${source.slice(begin, end)}${source.slice(saveBegin, saveEnd)}}; module.exports = Fixture;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  for (const mode of ['system', 'node']) {
    const module = { exports: {} };
    let file = '', installs = 0;
    new Function('module', 'process', 'execSync', 'ScheduleType', 'config', 'writeFileWithLock', 'CrontabModel', js)(
      module, { env: { QL_SCHEDULER: mode } }, () => { installs++; }, ScheduleType,
      { crontabFile: '/unused' }, async (_, data) => { file = data; }, { update: async () => {} },
    );
    const service = new module.exports();
    service.makeCommand = (row) => `task ${row.id}.js`;
    const rows = [
      { id: 'plain', schedule: '*/5 0-23 * * 1,3' },
      { id: 'spaces', schedule: '  0\t0 * * *  ' },
      { id: 'numeric-step', schedule: '0/5 * * * *' },
      { id: 'sunday-seven', schedule: '0 0 * * 7' },
      { id: 'day-step', schedule: '0 0 */2 * *' },
      { id: 'restricted-days', schedule: '0 0 1-31 * 1' },
      { id: 'restricted-week', schedule: '0 0 1 * 0-6' },
      { id: 'annually', schedule: '@annually' },
      { id: 'midnight', schedule: '@midnight' },
      { id: 'minutely', schedule: '@minutely' },
      { id: 'seconds', schedule: '0 0 * * * *' },
      { id: 'question', schedule: '0 0 * * ?' },
      { id: 'last', schedule: '0 0 L * *' },
      { id: 'nth', schedule: '0 0 * * 1#2' },
      { id: 'named', schedule: '0 0 * JAN MON' },
      { id: 'macro', schedule: '@daily' },
      { id: 'short', schedule: '*' },
      { id: 'extra', schedule: '* * * * *', extra_schedules: [{ schedule: '0 * * * *' }] },
      { id: 'once', schedule: '@once' },
      { id: 'boot', schedule: '@boot' },
    ];
    for (const row of rows) {
      const special = ['once', 'boot'].includes(row.id);
      const portable = ['plain', 'spaces'].includes(row.id);
      assert.equal(service.shouldUseCronClient(row), !special && (mode === 'node' || !portable), `${mode}: ${row.id}`);
    }
    await service.setCrontab({ data: rows, total: rows.length });
    assert.equal(installs, mode === 'system' ? 1 : 0);
    for (const id of ['numeric-step', 'sunday-seven', 'day-step', 'restricted-days', 'restricted-week', 'annually', 'midnight', 'minutely', 'seconds', 'question', 'last', 'nth', 'named', 'macro', 'short', 'extra', 'once', 'boot']) {
      const line = file.split('\n').find((line) => line.endsWith(`task ${id}.js`));
      assert.ok(line.startsWith('# '), `${mode}: ${id} cannot also run from system crontab`);
    }
  }
});
