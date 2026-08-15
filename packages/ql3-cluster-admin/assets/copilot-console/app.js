'use strict';

(function () {
  const schema = 'qinglong/cluster-copilot-console-read-request@v1';
  const routes = Object.freeze({
    inspect: '/api/v1/copilot/inspect',
    output: '/api/v1/copilot/output',
    run_list: '/api/v1/observe/run-list',
    run_read: '/api/v1/observe/run',
    run_event_list: '/api/v1/observe/run-events',
    run_step_list: '/api/v1/observe/run-steps',
    task_list: '/api/v1/observe/task-list',
    task_read: '/api/v1/observe/task',
    workflow_list: '/api/v1/observe/workflow-list',
    workflow_run_list: '/api/v1/observe/workflow-run-list',
    workflow_run_read: '/api/v1/observe/workflow-run',
    workflow_event_list: '/api/v1/observe/workflow-events',
    workflow_step_list: '/api/v1/observe/workflow-steps',
  });
  const labels = Object.freeze({
    inspect: 'Copilot 诊断状态',
    output: 'Copilot 诊断内容',
    run_list: 'Run 目录',
    run_read: 'Run 详情',
    run_event_list: 'Run Events',
    run_step_list: 'Run Steps',
    task_list: 'Task 目录',
    task_read: 'Task 当前修订',
    workflow_list: 'Workflow 目录',
    workflow_run_list: 'Workflow Run 目录',
    workflow_run_read: 'Workflow Run 详情',
    workflow_event_list: 'Workflow Run Events',
    workflow_step_list: 'Workflow Run Steps',
  });
  const bundleApi = globalThis.QingLongEvidenceBundle;
  const sessionForm = document.getElementById('session-form');
  const sessionInput = document.getElementById('session-token');
  const controls = document.getElementById('console-controls');
  const ledger = document.getElementById('ledger');
  const emptyState = document.getElementById('empty-state');
  const message = document.getElementById('message');
  const statusChip = document.getElementById('status-chip');
  const ledgerMeta = document.getElementById('ledger-meta');
  const exportButton = document.getElementById('export-evidence');
  const clearButton = document.getElementById('clear-evidence');
  const evidenceRecords = [];
  let sessionToken = '';
  let busy = false;
  let exporting = false;
  let evidenceBytes = 0;

  const value = function (id) {
    return document.getElementById(id).value.trim();
  };

  const requestId = function () {
    return 'console-' + crypto.randomUUID();
  };

  const setMessage = function (text, tone) {
    message.textContent = text;
    message.dataset.tone = tone || 'neutral';
  };

  const updateLedgerState = function () {
    const count = evidenceRecords.length;
    ledgerMeta.textContent =
      String(count) +
      '/' +
      String(bundleApi.limits.maximumRecords) +
      ' 条 · ' +
      String(Math.ceil(evidenceBytes / 1024)) +
      ' KiB 原始事实';
    emptyState.hidden = count !== 0;
    ledger.hidden = count === 0;
    exportButton.disabled = busy || exporting || count === 0;
    clearButton.disabled = busy || exporting || count === 0;
  };

  const setBusy = function (next) {
    busy = next;
    document.querySelectorAll('[data-read]').forEach(function (button) {
      button.disabled = next;
    });
    if (next) {
      statusChip.textContent = '读取中';
      statusChip.dataset.tone = 'busy';
    } else if (statusChip.dataset.tone === 'busy') {
      statusChip.textContent = '只读就绪';
      statusChip.dataset.tone = 'success';
    }
    updateLedgerState();
  };

  const base = function (operation) {
    const projectId = value('project-id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) {
      throw new Error('project_id_invalid');
    }
    return {
      schema: schema,
      operation: operation,
      projectId: projectId,
      requestId: requestId(),
    };
  };

  const payload = function (operation) {
    const result = base(operation);
    if (operation === 'inspect' || operation === 'output') {
      result.sourceRunId = value('source-run-id');
      result.requestId = value('diagnosis-request-id');
    } else if (operation === 'run_list') {
      result.afterCreatedAtMs = null;
      result.afterRunId = null;
      result.limit = 32;
    } else if (operation === 'run_read') {
      result.runId = value('run-id');
    } else if (operation === 'run_event_list') {
      result.runId = value('run-id');
      result.afterSequence = 0;
      result.limit = 32;
    } else if (operation === 'run_step_list') {
      result.runId = value('run-id');
      result.afterStepKey = null;
      result.afterStepRunId = null;
      result.limit = 32;
    } else if (operation === 'task_list') {
      result.afterTaskId = null;
      result.limit = 32;
    } else if (operation === 'task_read') {
      result.taskId = value('task-id');
    } else if (operation === 'workflow_list') {
      result.packageName = value('package-name');
    } else {
      result.packageName = value('package-name');
      result.workflowId = value('workflow-id');
      if (operation === 'workflow_run_list') {
        result.afterAdmittedAtMs = null;
        result.afterRunId = null;
        result.limit = 32;
      } else {
        result.runId = value('workflow-run-id');
        if (operation === 'workflow_event_list') {
          result.afterSequence = 0;
          result.limit = 32;
        } else if (operation === 'workflow_step_list') {
          result.afterStepKey = null;
          result.afterStepRunId = null;
          result.limit = 32;
        }
      }
    }
    return result;
  };

  const nextPage = function (operation, prior, fact) {
    const next = Object.assign({}, prior, { requestId: requestId() });
    if (operation === 'run_list' && fact.hasMore === true && fact.next) {
      next.afterCreatedAtMs = fact.next.createdAtMs;
      next.afterRunId = fact.next.runId;
    } else if (
      operation === 'task_list' &&
      fact.hasMore === true &&
      fact.next
    ) {
      next.afterTaskId = fact.next.taskId;
    } else if (operation === 'run_event_list' && fact.hasMore === true) {
      next.afterSequence = fact.nextAfterSequence;
    } else if (
      operation === 'run_step_list' &&
      fact.hasMore === true &&
      fact.next
    ) {
      next.afterStepKey = fact.next.stepKey;
      next.afterStepRunId = fact.next.stepRunId;
    } else if (
      operation === 'workflow_run_list' &&
      fact.truncated === true &&
      fact.next
    ) {
      next.afterAdmittedAtMs = fact.next.admittedAtMs;
      next.afterRunId = fact.next.runId;
    } else if (
      operation === 'workflow_event_list' &&
      fact.truncated === true &&
      fact.nextAfterSequence !== null
    ) {
      next.afterSequence = fact.nextAfterSequence;
    } else if (
      operation === 'workflow_step_list' &&
      fact.truncated === true &&
      fact.next
    ) {
      next.afterStepKey = fact.next.stepKey;
      next.afterStepRunId = fact.next.id;
    } else {
      return null;
    }
    return next;
  };

  const appendEvidence = function (operation, request, response) {
    const fact = response.result.result;
    const observedAtMs = Date.now();
    const record = {
      operation: operation,
      observedAtMs: observedAtMs,
      request: request,
      fact: fact,
    };
    const recordBytes = bundleApi.measureClusterConsoleEvidenceRecord(record);
    const entry = document.createElement('li');
    entry.className = 'ledger-entry';
    const header = document.createElement('header');
    const title = document.createElement('h3');
    const time = document.createElement('time');
    const output = document.createElement('pre');
    title.textContent = labels[operation];
    time.textContent = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(observedAtMs));
    output.tabIndex = 0;
    output.textContent = JSON.stringify(fact, null, 2);
    header.append(title, time);
    entry.append(header, output);
    const next = nextPage(operation, request, fact);
    if (next) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '显式读取下一页';
      button.addEventListener('click', function () {
        void execute(operation, next);
      });
      entry.append(button);
    }
    ledger.prepend(entry);
    evidenceRecords.push({ record: record, bytes: recordBytes, entry: entry });
    evidenceBytes += recordBytes;
    let evicted = 0;
    while (
      evidenceRecords.length > bundleApi.limits.maximumRecords ||
      evidenceBytes > bundleApi.limits.maximumRawBytes
    ) {
      const oldest = evidenceRecords.shift();
      evidenceBytes -= oldest.bytes;
      oldest.entry.remove();
      evicted += 1;
    }
    updateLedgerState();
    return evicted;
  };

  const execute = async function (operation, prepared) {
    if (busy) return;
    setBusy(true);
    setMessage('正在读取 ' + labels[operation] + '…');
    try {
      const body = prepared || payload(operation);
      const response = await fetch(routes[operation], {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'QL3-Console ' + sessionToken,
        },
        body: JSON.stringify(body),
      });
      const responseBody = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof responseBody.code === 'string'
            ? responseBody.code
            : 'console_request_failed',
        );
      }
      const evicted = appendEvidence(operation, body, responseBody);
      setMessage(
        labels[operation] +
          ' 已加入本页证据账本。' +
          (evicted === 0
            ? '刷新页面会清空。'
            : '为保持容量上限，已淘汰最旧记录。'),
        'success',
      );
    } catch (error) {
      statusChip.textContent = '读取失败';
      statusChip.dataset.tone = 'failed';
      setMessage(
        '无法读取：' +
          (error instanceof Error ? error.message : 'console_request_failed'),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const clearEvidence = function () {
    for (const evidence of evidenceRecords) evidence.entry.remove();
    evidenceRecords.length = 0;
    evidenceBytes = 0;
    statusChip.textContent = '账本已清空';
    statusChip.dataset.tone = 'success';
    updateLedgerState();
    setMessage('本页证据账本已清空；没有向服务端发送请求。', 'success');
  };

  const exportEvidence = async function () {
    if (busy || exporting || evidenceRecords.length === 0) return;
    exporting = true;
    updateLedgerState();
    setMessage('正在本页内存中生成脱敏证据包…');
    try {
      const generatedAtMs = Date.now();
      const bundle = await bundleApi.createClusterConsoleEvidenceBundle(
        evidenceRecords.map(function (evidence) {
          return evidence.record;
        }),
        generatedAtMs,
      );
      const encoded = bundleApi.serializeClusterConsoleEvidenceBundle(bundle);
      const blob = new Blob([encoded], {
        type: 'application/json;charset=utf-8',
      });
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.download =
          'qinglong-cluster-evidence-' +
          new Date(generatedAtMs).toISOString().replaceAll(':', '-') +
          '.json';
        anchor.href = objectUrl;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      statusChip.textContent = '脱敏包已生成';
      statusChip.dataset.tone = 'success';
      setMessage(
        '已下载 ' +
          String(bundle.source.entryCount) +
          ' 条脱敏事实；未发起额外 Cluster 读取。',
        'success',
      );
    } catch (error) {
      statusChip.textContent = '导出失败';
      statusChip.dataset.tone = 'failed';
      setMessage(
        '无法导出：' +
          (error instanceof Error
            ? error.message
            : 'cluster_evidence_bundle_failed'),
        'error',
      );
    } finally {
      exporting = false;
      updateLedgerState();
    }
  };

  sessionForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const candidate = sessionInput.value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) {
      setMessage('浏览器访问密钥格式无效。', 'error');
      return;
    }
    sessionToken = candidate;
    sessionInput.value = '';
    sessionForm.hidden = true;
    controls.hidden = false;
    statusChip.textContent = '只读就绪';
    statusChip.dataset.tone = 'success';
    setMessage('本页已解锁；Cluster credential 仍只存在于服务端。', 'success');
    document.getElementById('project-id').focus();
  });

  document.querySelectorAll('.mode-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.mode-tab').forEach(function (candidate) {
        const selected = candidate === tab;
        candidate.classList.toggle('active', selected);
        candidate.setAttribute('aria-pressed', String(selected));
      });
      document.querySelectorAll('.mode-panel').forEach(function (panel) {
        panel.hidden = panel.id !== tab.dataset.panel;
      });
    });
  });

  document.querySelectorAll('[data-read]').forEach(function (button) {
    button.addEventListener('click', function () {
      void execute(button.dataset.read);
    });
  });

  exportButton.addEventListener('click', function () {
    void exportEvidence();
  });

  clearButton.addEventListener('click', clearEvidence);

  window.addEventListener('pagehide', function () {
    sessionToken = '';
    evidenceRecords.length = 0;
    evidenceBytes = 0;
    ledger.textContent = '';
  });

  updateLedgerState();
})();
