const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const intl = require('react-intl-universal');
const zh = require('../../src/locales/zh-CN.json');
const en = require('../../src/locales/en-US.json');

// Render the actual TSX, including disclosure markup and translated field names.
const source = fs.readFileSync(
  require.resolve('../../src/pages/crontab/triggerTiming.tsx'),
  'utf8',
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2022,
  },
});
const output = {};
Function('require', 'exports', outputText)(require, output);
const base = new Date(2026, 10, 16, 14, 55).getTime();
before(() =>
  intl.init({ currentLocale: 'zh-CN', locales: { 'zh-CN': zh, 'en-US': en } }),
);

function render(fields) {
  const html = renderToStaticMarkup(
    React.createElement(output.default, {
      row: {
        observed_at: base,
        state: 'running',
        source: 'node',
        exit_code: null,
        ...fields,
      },
    }),
  );
  const [summary, details] = html.split(/<details[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(details, /<summary>时间明细<\/summary>/);
  assert.equal((details.match(/<dt>/g) || []).length, 6);
  return { summary, details };
}

test('summary separates 57 ms in queue from 158 ms to command start and optional script entry', () => {
  const fields = {
    scheduled_at: base,
    queued_at: base + 10,
    started_at: base + 67,
    command_started_at: base + 158,
  };
  for (const script_started_at of [null, base + 201]) {
    const { summary, details } = render({ ...fields, script_started_at });
    assert.match(summary, /排队等待 <b>57 ms/);
    assert.match(summary, /计划到命令启动 <b>158 ms/);
    assert.doesNotMatch(summary, /结束时间|脚本/);
    assert.match(details, /命令启动<\/dt><dd>14:55:00.158/);
    if (script_started_at == null) {
      assert.match(details, /脚本开始执行（采样）<\/dt><dd>未采集到开始时间/);
      assert.doesNotMatch(details, /计划到脚本开始/);
    } else {
      assert.match(details, /计划到脚本开始 <b>201 ms/);
    }
  }
  const { summary } = render({
    ...fields,
    state: 'finished',
    finished_at: base + 3158,
  });
  assert.match(summary, /计划到命令启动 <b>158 ms/);
  assert.match(summary, /结束时间 <b>14:55:03/);
});

test('only a currently queued run accumulates wait; skip or stop freezes the wait', (t) => {
  t.mock.method(Date, 'now', () => base + 7000);
  const fields = { queued_at: base, scheduled_at: base, started_at: null };
  assert.match(render({ ...fields, state: 'queued' }).summary, /已排队 <b>7 s/);
  const { summary, details } = render({
    ...fields,
    state: 'skipped',
    finished_at: base + 12,
  });
  assert.doesNotMatch(summary, /已排队|计划到命令启动|排队等待/);
  assert.match(details, /跳过前等待 <b>12 ms/);
  const stopped = render({
    ...fields,
    state: 'stopped',
    finished_at: base + 2100,
  });
  assert.match(stopped.summary, /排队等待 <b>2.1 s/);
  const unknown = render({
    ...fields,
    state: 'unknown',
    finished_at: base + 6000,
  });
  assert.doesNotMatch(unknown.summary, /排队等待|结束时间|已排队/);
  assert.match(unknown.details, /状态记录时间/);
});

test('manual and legacy rows never synthesize a schedule, queue time, command start or sample', () => {
  const manual = render({
    source: 'manual',
    queued_at: base,
    started_at: base + 30,
    command_started_at: base + 51,
  });
  assert.match(manual.summary, /进入队列/);
  assert.match(manual.summary, /命令启动 <b>14:55:00/);
  assert.doesNotMatch(manual.summary, /计划到命令启动/);
  for (const source of ['system', 'legacy', 'client']) {
    const { summary, details } = render({
      source,
      started_at: base,
      state: 'failed',
      exit_code: 17,
    });
    assert.match(summary, /记录启动/);
    assert.match(summary, /退出码 <b>17/);
    assert.doesNotMatch(summary, /计划运行|排队等待|计划到命令启动/);
    assert.match(details, /记录启动<\/dt><dd>14:55:00.000/);
    assert.match(details, /命令启动<\/dt><dd>未记录/);
  }
});

test('retain precision and dates across midnight, accept zero latency, omit reversed timestamps', () => {
  const scheduled = new Date(2026, 11, 31, 23, 59, 59, 900).getTime();
  const { summary, details } = render({
    state: 'finished',
    scheduled_at: scheduled,
    queued_at: scheduled,
    started_at: scheduled,
    command_started_at: scheduled + 150,
    finished_at: scheduled + 3100,
  });
  assert.match(summary, /2026-12-31 23:59:59/);
  assert.match(summary, /排队等待 <b>0 ms/);
  assert.match(summary, /结束时间 <b>2027-01-01 00:00:03/);
  assert.match(details, /命令启动<\/dt><dd>2027-01-01 00:00:00.050/);
  assert.doesNotMatch(
    render({ scheduled_at: base, command_started_at: base - 1 }).summary,
    /计划到命令启动/,
  );
});

test('an entry sample with no schedule names the measured starting point and keeps millisecond precision', () => {
  const script_started_at = base + 1635;
  const manual = render({
    source: 'manual',
    queued_at: base,
    started_at: base + 10,
    script_started_at,
  });
  assert.match(manual.details, /入队到脚本开始 <b>1.635 s/);
  const client = render({
    source: 'client',
    started_at: base,
    script_started_at,
  });
  assert.match(client.details, /启动记录到脚本开始 <b>1.635 s/);
  for (const { summary, details } of [manual, client]) {
    assert.doesNotMatch(summary + details, /计划到脚本开始|计划到命令启动/);
  }
});

test('an expanded queued row uses its server snapshot even when the browser clock is ten minutes fast', (t) => {
  t.mock.method(Date, 'now', () => base + 600000);
  const queued = { queued_at: base, queue_wait_ms: 375, state: 'queued' };
  assert.match(render(queued).summary, /已排队 <b>375 ms/);
  assert.match(
    render({ ...queued, queue_wait_ms: 0 }).summary,
    /已排队 <b>0 ms/,
  );
  assert.match(
    render({ ...queued, state: 'running', started_at: base + 812 }).summary,
    /排队等待 <b>812 ms/,
  );
});

test('expanded wait reasons retain the actual slot holders after the timer freezes', () => {
  const queue_context = JSON.stringify({
    queue: 'manual',
    limit: 2,
    occupied: 2,
    holders: [
      { id: 'instance-101', name: '长任务 A' },
      { id: 'instance-102', name: '长任务 B' },
    ],
  });
  const { summary, details } = render({
    state: 'finished',
    queued_at: base,
    started_at: base + 3712,
    finished_at: base + 5000,
    queue_context,
  });
  assert.match(summary, /排队等待 <b>3.712 s/);
  assert.match(details, /手动执行队列/);
  assert.match(details, /入队时已达并发上限（运行 2，上限 2）/);
  assert.match(details, /长任务 A/);
  assert.match(details, /长任务 B/);
  assert.match(
    render({ state: 'queued', queued_at: base }).details,
    /尚无同时运行的任务记录/,
  );
});

test('a live queue shows the resampled holders and preserves the measured dequeue time after preparation', () => {
  const admission = JSON.stringify({
    queue: 'manual',
    occupied: 2,
    limit: 2,
    holders: [
      { id: 'a', name: 'holder-A' },
      { id: 'b', name: 'holder-B' },
    ],
  });
  const live = JSON.stringify({
    queue: 'manual',
    occupied: 1,
    limit: 1,
    holders: [{ id: 'b', name: 'holder-B' }],
  });
  const row = {
    state: 'queued',
    queued_at: base,
    queue_context: admission,
    queue_live_context: live,
  };
  assert.match(render(row).details, /最近一次检查（运行 1，上限 1）/);
  assert.doesNotMatch(render(row).details, /holder-A/);
  assert.match(
    render({
      ...row,
      state: 'finished',
      dequeued_at: base + 210,
      started_at: base + 810,
    }).summary,
    /排队等待 <b>210 ms/,
  );
});
