const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture } = require('./support/consoleClient.cjs');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const uuid = '12345678-1234-4234-8234-123456789abc';
const proof = `ql3p_${uuid}_${'A'.repeat(43)}`;
const challenge = {
  httpStatus: 428,
  code: 'local_presence_required',
  proofFileName: `${uuid}.json`,
  expiresAtMs: Date.now() + 120000,
};
const metadata = {
  secrets: [
    {
      name: 'old-session-only',
      currentVersion: 1,
      createdAtMs: 0,
      secretRef:
        'qlsecret:v1:' +
        Buffer.from(
          JSON.stringify({
            projectId: 'default',
            name: 'old-session-only',
            version: 1,
          }),
        ).toString('base64url'),
    },
  ],
  truncated: false,
};
const task = {
  taskId: 'task-a',
  revision: 1,
  name: 'private old definition',
  kind: 'command',
  contentDigest: 'a'.repeat(64),
  labels: {},
  enabled: true,
  spec: {
    schema: 'qinglong/command@v1',
    config: {
      command: { kind: 'argv', file: '/bin/echo', args: ['private argument'] },
    },
  },
};
const definition = {
  task,
  authoring: {
    lease: `ql3a_${uuid}_${'A'.repeat(43)}`,
    expiresAtMs: Date.now() + 600000,
    revision: 1,
    contentDigest: task.contentDigest,
  },
};
const sessionChanged = (error) => error.code === 'session_changed';

test('Trigger preparation cannot send a write after its pinned Task read crosses sessions', async () => {
  const response = deferred();
  const client = fixture('triggers', () => response.promise);
  client.nodes.triggerId.value = 'cron-a';
  client.nodes.triggerTaskId.value = task.taskId;
  client.nodes.triggerExpression.value = '* * * * *';
  client.nodes.triggerTimezone.value = 'UTC';
  client.nodes.triggerMisfire.value = 'skip';
  const saving = client.saveTriggerDraft();
  client.disconnect();
  client.state.token = 'new-session-token';
  response.resolve({ task });
  await saving;
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].options.method, 'GET');
  assert.equal(client.state.pendingPresence, null);
  assert.equal(client.nodes.presenceDialog.open, false);
});

for (const action of ['startTask', 'cancelRun']) {
  test(`${action}: reconnect during post-write refresh cannot select the old Run`, async () => {
    const response = deferred(),
      started = deferred();
    const client = fixture('runs', (_url, _count, options) => {
      if (options.method === 'POST')
        return { status: 'accepted', runId: 'run-a' };
      started.resolve();
      return response.promise;
    });
    const writing = client[action](
      action === 'startTask' ? task : { id: 'run-a' },
    );
    await started.promise;
    client.disconnect();
    client.state.token = 'new-session-token';
    client.state.view = 'secrets';
    response.resolve({ runs: [], hasMore: false });
    await writing;
    assert.equal(client.calls.length, 2);
    assert.equal(client.state.view, 'secrets');
    assert.equal(client.state.selectedId, null);
  });
}

test('late Secret catalog cannot repopulate cleared state after disconnect', async () => {
  const response = deferred();
  const client = fixture('tasks', () => response.promise);
  const reading = client.loadSecretCatalog();
  client.disconnect();
  response.resolve(metadata);
  await assert.rejects(reading, sessionChanged);
  assert.equal(client.state.token, null);
  assert.equal(client.state.secretCatalog.length, 0);
});

test('late response body decoding is fenced across reconnect with the same credential', async () => {
  const body = deferred(),
    decoding = deferred();
  const client = fixture('tasks', (url) =>
    url === '/probe'
      ? {
          json() {
            decoding.resolve();
            return body.promise;
          },
        }
      : { tasks: [], hasMore: false },
  );
  const reading = client.api('/probe');
  await decoding.promise;
  client.connect(client.state.token, 'default');
  body.resolve({ private: 'previous connection' });
  await assert.rejects(reading, sessionChanged);
});

test('late transport failure is also a stale session result', async () => {
  const response = deferred();
  const client = fixture('tasks', () => response.promise);
  const reading = client.api('/probe');
  client.disconnect();
  response.reject(new Error('old transport'));
  await assert.rejects(reading, sessionChanged);
});

test('new Task preparation cannot reopen an editor after disconnect', async () => {
  const response = deferred();
  const client = fixture('tasks', () => response.promise);
  const reading = client.nodes.createTask.listeners.click();
  client.disconnect();
  const toast = client.nodes.toast.textContent;
  response.resolve(metadata);
  await reading;
  assert.equal(client.state.secretCatalog.length, 0);
  assert.equal(client.nodes.taskEditor.open, false);
  assert.equal(client.nodes.toast.textContent, toast);
});

test('late authoring challenge cannot replace a new pending operation', async () => {
  const response = deferred();
  const client = fixture('tasks', () => response.promise);
  const reading = client.beginTaskAuthoring(task);
  client.disconnect();
  const current = { kind: 'new-session-marker' };
  client.state.pendingPresence = current;
  response.resolve(challenge);
  await reading;
  assert.equal(client.state.pendingPresence, current);
  assert.equal(client.nodes.presenceDialog.open, false);
});

test('late authorized definition cannot open an editor or unlock a new proof submission', async () => {
  const response = deferred();
  const client = fixture('tasks', () => response.promise);
  client.state.pendingPresence = { kind: 'authoring', taskId: task.taskId };
  client.nodes.presenceProof.value = proof;
  const reading = client.completeTaskMutation();
  client.disconnect();
  assert.equal(client.nodes.presenceSubmit.disabled, false);
  client.state.token = 'new-session-token';
  client.nodes.presenceSubmit.disabled = true;
  response.resolve(definition);
  await reading;
  assert.equal(client.nodes.taskEditor.open, false);
  assert.equal(client.state.authoringSnapshot, null);
  assert.equal(client.nodes.presenceSubmit.disabled, true);
  assert.equal(client.calls.length, 1);
});

test('disconnect during authoring catalog enrichment discards the captured full definition', async () => {
  const response = deferred(),
    enrichment = deferred();
  const client = fixture('tasks', (url) => {
    if (url.includes('/secrets?')) {
      enrichment.resolve();
      return response.promise;
    }
    return definition;
  });
  client.state.pendingPresence = { kind: 'authoring', taskId: task.taskId };
  client.nodes.presenceProof.value = proof;
  const reading = client.completeTaskMutation();
  await enrichment.promise;
  client.disconnect();
  const currentCatalog = [];
  client.state.secretCatalog = currentCatalog;
  response.resolve(metadata);
  await reading;
  assert.equal(client.state.secretCatalog, currentCatalog);
  assert.equal(client.nodes.taskEditor.open, false);
  assert.equal(client.state.authoringSnapshot, null);
});

for (const action of ['startTask', 'cancelRun']) {
  test(`${action}: an already-sent write never causes follow-up reads in another session`, async () => {
    const response = deferred();
    const client = fixture('tasks', () => response.promise);
    const reading = client[action](
      action === 'startTask' ? task : { id: 'run-a' },
    );
    client.disconnect();
    client.state.token = 'new-session-token';
    client.state.view = 'secrets';
    const toast = client.nodes.toast.textContent;
    response.resolve({ status: 'accepted', runId: 'run-a' });
    await reading;
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].options.method, 'POST');
    assert.equal(client.state.view, 'secrets');
    assert.equal(client.nodes.toast.textContent, toast);
  });
}

for (const kind of ['task', 'trigger', 'secret']) {
  test(`${kind} draft: stale challenge and finally cannot mutate a new editor`, async () => {
    const response = deferred(),
      sent = deferred();
    const client = fixture('tasks', (_url, _count, options) => {
      if (options.method === 'GET') return { task };
      sent.resolve();
      return response.promise;
    });
    Object.assign(client.nodes.taskId, { value: 'task-a' });
    client.nodes.taskName.value = 'Task';
    client.nodes.taskCommand.value = '/bin/echo';
    client.nodes.taskArgs.value = 'test';
    client.nodes.taskEnabled.checked = true;
    client.nodes.triggerId.value = 'cron-a';
    client.nodes.triggerTaskId.value = 'task-a';
    client.nodes.triggerExpression.value = '* * * * *';
    client.nodes.triggerTimezone.value = 'UTC';
    client.nodes.triggerMisfire.value = 'skip';
    client.nodes.triggerEnabled.checked = true;
    client.nodes.secretName.value = 'key';
    client.nodes.secretValue.value = 'synthetic-private-value';
    const action = {
      task: 'saveTaskDraft',
      trigger: 'saveTriggerDraft',
      secret: 'saveSecretDraft',
    }[kind];
    const control = client.nodes[`${kind}EditorSave`];
    const reading = client[action]();
    await sent.promise;
    client.disconnect();
    assert.equal(control.disabled, false);
    client.state.token = 'new-session-token';
    control.disabled = true;
    response.resolve(challenge);
    await reading;
    assert.equal(control.disabled, true);
    assert.equal(client.nodes.presenceDialog.open, false);
    assert.equal(client.state.pendingPresence, null);
  });
}

test('current-session authoring and permission errors still reach the expected UI', async () => {
  const client = fixture('tasks', (_url, count) =>
    count === 1 ? challenge : { httpStatus: 403, code: 'authorization_denied' },
  );
  await client.beginTaskAuthoring(task);
  assert.equal(client.nodes.presenceDialog.open, true);
  assert.equal(client.state.pendingPresence.kind, 'authoring');
  await client.beginTaskAuthoring(task);
  assert.match(client.nodes.toast.textContent, /没有执行该操作的权限/);
});
