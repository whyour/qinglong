(() => {
  'use strict';

  const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const CRON_FIELD_PATTERN = /^[0-9A-Za-z*?,/#LW-]+$/;
  const TOKEN_PATTERN =
    /^ql3c_[A-Za-z0-9][A-Za-z0-9._:-]{0,63}_[A-Za-z0-9_-]{43}$/;
  const PRESENCE_PATTERN =
    /^ql3p_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;
  const AUTHORING_LEASE_PATTERN =
    /^ql3a_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;
  const LOG_READ_BYTES = 32 * 1024;
  const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
  const STATUS_LABELS = Object.freeze({
    created: '已创建',
    queued: '排队中',
    dispatching: '派发中',
    running: '运行中',
    cancel_requested: '正在取消',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
    timed_out: '已超时',
  });
  const ERROR_LABELS = Object.freeze({
    authentication_required: '凭据无效或已经失效。请断开连接后重新输入。',
    authorization_denied: '当前身份没有执行该操作的权限。',
    server_overloaded: '设备正在处理其他请求，请稍后刷新。',
    server_draining: '服务正在停止，暂不接受新请求。',
    task_list_unavailable: '任务列表暂时不可用。请检查本机服务与数据库。',
    task_query_unavailable: '任务详情暂时不可用。',
    run_list_unavailable: '运行列表暂时不可用。请检查本机服务与数据库。',
    run_query_unavailable: '运行详情暂时不可用。',
    run_event_list_unavailable: '运行事件暂时不可用。',
    run_step_list_unavailable: 'Workflow Step 暂时不可用。',
    task_start_fence_rejected:
      '任务在确认期间发生变化，本次启动已安全拒绝。请刷新后重试。',
    local_presence_rejected:
      '本机证明不匹配或已过期。请核对文件；过期后关闭窗口并重新保存。',
    local_presence_unavailable:
      '暂时无法生成本机证明。请检查部署数据目录权限。',
    strong_authentication_required:
      '当前凭据不能执行管理操作；请使用本机 User API Credential。',
    task_definition_fence_rejected:
      'Task 或授权在确认期间发生变化。请刷新后重新编辑。',
    task_authoring_lease_required:
      '更新 Task 前必须重新读取完整定义。请关闭编辑器后选择“编辑任务”。',
    task_authoring_lease_rejected:
      'Task、凭据或编辑租约已经变化。请关闭编辑器后重新读取。',
    task_authoring_unavailable:
      '暂时无法建立安全编辑会话。请稍后重新读取 Task。',
    invalid_task_definition: 'Task 定义无效。请检查 ID、命令与参数。',
    task_definition_unavailable: 'Task 暂时无法保存。请检查数据库状态。',
    trigger_query_unavailable: '定时触发器暂时不可读取。请检查数据库状态。',
    trigger_fence_rejected:
      'Trigger、Task 或授权在确认期间发生变化。请刷新后重新编辑。',
    invalid_trigger: '定时配置无效。请检查表达式、时区与 Task 状态。',
    trigger_unavailable: '定时配置暂时无法保存。请检查数据库状态。',
    run_cancellation_fence_rejected:
      '运行在确认期间发生变化，本次取消已安全拒绝。请刷新后重试。',
    request_unavailable: '本次请求没有完成，请确认服务仍在运行。',
  });

  const nodes = Object.freeze({
    form: document.getElementById('credential-form'),
    project: document.getElementById('project-input'),
    token: document.getElementById('token-input'),
    disconnect: document.getElementById('disconnect-button'),
    connection: document.getElementById('connection-state'),
    connectionLabel: document.getElementById('connection-label'),
    nav: document.querySelector('.section-nav'),
    ledger: document.getElementById('ledger'),
    detail: document.getElementById('detail'),
    kicker: document.getElementById('section-kicker'),
    title: document.getElementById('section-title'),
    description: document.getElementById('section-description'),
    refresh: document.getElementById('refresh-button'),
    createTask: document.getElementById('create-task-button'),
    createTrigger: document.getElementById('create-trigger-button'),
    dialog: document.getElementById('confirmation-dialog'),
    dialogTitle: document.getElementById('confirmation-title'),
    dialogCopy: document.getElementById('confirmation-copy'),
    dialogAccept: document.getElementById('confirmation-accept'),
    taskEditor: document.getElementById('task-editor-dialog'),
    taskEditorTitle: document.getElementById('task-editor-title'),
    taskEditorIntro: document.getElementById('task-editor-intro'),
    taskEditorNote: document.getElementById('task-editor-note'),
    taskEditorForm: document.getElementById('task-editor-form'),
    taskEditorClose: document.getElementById('task-editor-close'),
    taskEditorSave: document.getElementById('task-editor-save'),
    taskId: document.getElementById('task-id-input'),
    taskName: document.getElementById('task-name-input'),
    taskDescription: document.getElementById('task-description-input'),
    taskCommand: document.getElementById('task-command-input'),
    taskArgs: document.getElementById('task-args-input'),
    taskEnabled: document.getElementById('task-enabled-input'),
    taskEnabledLabel: document.getElementById('task-enabled-label'),
    triggerEditor: document.getElementById('trigger-editor-dialog'),
    triggerEditorTitle: document.getElementById('trigger-editor-title'),
    triggerEditorIntro: document.getElementById('trigger-editor-intro'),
    triggerEditorForm: document.getElementById('trigger-editor-form'),
    triggerEditorClose: document.getElementById('trigger-editor-close'),
    triggerEditorSave: document.getElementById('trigger-editor-save'),
    triggerId: document.getElementById('trigger-id-input'),
    triggerTaskId: document.getElementById('trigger-task-id-input'),
    triggerExpression: document.getElementById('trigger-expression-input'),
    triggerTimezone: document.getElementById('trigger-timezone-input'),
    triggerMisfire: document.getElementById('trigger-misfire-input'),
    triggerEnabled: document.getElementById('trigger-enabled-input'),
    presenceDialog: document.getElementById('presence-dialog'),
    presenceForm: document.getElementById('presence-form'),
    presenceCopy: document.getElementById('presence-copy'),
    presenceFile: document.getElementById('presence-file'),
    presenceProof: document.getElementById('presence-proof-input'),
    presenceExpiry: document.getElementById('presence-expiry'),
    presenceError: document.getElementById('presence-error'),
    presenceCancel: document.getElementById('presence-cancel'),
    presenceSubmit: document.getElementById('presence-submit'),
    toast: document.getElementById('toast'),
  });

  const state = {
    token: null,
    project: 'default',
    view: 'tasks',
    selectedId: null,
    pendingAction: null,
    pendingPresence: null,
    authoringSnapshot: null,
    triggerSnapshot: null,
    toastTimer: null,
  };

  class ConsoleRequestError extends Error {
    constructor(code, status, requestId) {
      super(code);
      this.name = 'ConsoleRequestError';
      this.code = code;
      this.status = status;
      this.requestId = requestId;
    }
  }

  function element(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  }

  function replace(node, ...children) {
    node.replaceChildren(...children);
  }

  function formatTime(value) {
    if (!Number.isSafeInteger(value) || value < 0) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  }

  function shortDigest(value) {
    return typeof value === 'string' && value.length > 18
      ? `${value.slice(0, 10)}…${value.slice(-6)}`
      : value || '—';
  }

  function decodeBase64Utf8(value) {
    if (
      typeof value !== 'string' ||
      value.length > 48 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    ) {
      return null;
    }
    try {
      const binary = window.atob(value);
      if (binary.length > LOG_READ_BYTES) return null;
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return null;
    }
  }

  function statusTone(status) {
    if (status === 'failed' || status === 'timed_out') return 'failed';
    if (
      status === 'created' ||
      status === 'queued' ||
      status === 'dispatching' ||
      status === 'cancel_requested'
    ) {
      return 'waiting';
    }
    if (status === 'cancelled') return 'quiet';
    return 'active';
  }

  function statusBadge(status) {
    const badge = element('span', 'status', STATUS_LABELS[status] || status);
    badge.dataset.tone = statusTone(status);
    return badge;
  }

  function newMutationId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  async function api(path, options = {}) {
    if (!state.token) {
      throw new ConsoleRequestError('authentication_required', 401, null);
    }
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${state.token}`,
    };
    let body;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    if (options.presence !== undefined) {
      headers['x-qinglong-local-presence'] = options.presence;
    }
    if (options.authoringLease !== undefined) {
      headers['x-qinglong-task-authoring-lease'] = options.authoringLease;
    }
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new ConsoleRequestError('request_unavailable', 503, null);
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw new ConsoleRequestError(
        'response_unavailable',
        response.status,
        response.headers.get('x-request-id'),
      );
    }
    if (!response.ok && response.status !== options.acceptStatus) {
      throw new ConsoleRequestError(
        typeof value.code === 'string' ? value.code : 'request_unavailable',
        response.status,
        response.headers.get('x-request-id'),
      );
    }
    return value;
  }

  function describeError(error) {
    if (!(error instanceof ConsoleRequestError))
      return '操作没有完成，请刷新后重试。';
    const label = ERROR_LABELS[error.code] || `请求被拒绝：${error.code}`;
    return error.requestId ? `${label} 请求编号 ${error.requestId}` : label;
  }

  function showToast(message, tone = 'ok') {
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    nodes.toast.textContent = message;
    nodes.toast.dataset.tone = tone;
    nodes.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      nodes.toast.hidden = true;
      state.toastTimer = null;
    }, 5_000);
  }

  function setConnection(mode, label) {
    nodes.connection.dataset.state = mode;
    nodes.connectionLabel.textContent = label;
  }

  function setBusy(value) {
    nodes.ledger.setAttribute('aria-busy', String(value));
    nodes.refresh.disabled = value;
  }

  function loading() {
    const box = element('div', 'loading-state');
    box.append(element('span'));
    replace(nodes.ledger, box);
    setBusy(true);
  }

  function empty(message) {
    const box = element('div', 'empty-state');
    box.append(element('p', null, message));
    replace(nodes.ledger, box);
  }

  function errorState(error) {
    const box = element('div', 'error-state');
    box.append(element('p', null, describeError(error)));
    const retry = element('button', 'action-button', '重新读取');
    retry.type = 'button';
    retry.addEventListener('click', () => refresh());
    box.append(retry);
    replace(nodes.ledger, box);
    setConnection('error', '连接需要检查');
  }

  function detailEmpty(message = '选择一项，查看它的执行围栏与事件轨迹。') {
    const box = element('div', 'detail-empty');
    box.append(element('span', 'detail-glyph', '⌁'));
    box.append(element('p', null, message));
    replace(nodes.detail, box);
  }

  function listHeader(label, count) {
    const header = element('div', 'list-header');
    header.append(element('strong', null, label));
    header.append(element('span', null, `${count} 条 / 当前窗口`));
    return header;
  }

  function recordMeta(values) {
    const meta = element('span', 'record-meta');
    for (const value of values) meta.append(element('span', null, value));
    return meta;
  }

  function fact(label, value) {
    const item = element('dl', 'fact');
    item.append(element('dt', null, label));
    item.append(element('dd', null, value));
    return item;
  }

  function detailHeader(kicker, title, identity) {
    const header = element('header', 'detail-header');
    header.append(element('p', 'eyebrow', kicker));
    header.append(element('h3', null, title));
    header.append(element('code', null, identity));
    return header;
  }

  function actionButton(label, handler, kind = 'normal') {
    const button = element('button', 'action-button', label);
    button.type = 'button';
    button.dataset.kind = kind;
    button.addEventListener('click', handler);
    return button;
  }

  function confirmAction(title, copy, acceptLabel, action, dangerous = false) {
    state.pendingAction = action;
    nodes.dialogTitle.textContent = title;
    nodes.dialogCopy.textContent = copy;
    nodes.dialogAccept.textContent = acceptLabel;
    nodes.dialogAccept.className = dangerous
      ? 'danger-button'
      : 'primary-button';
    nodes.dialog.returnValue = '';
    nodes.dialog.showModal();
  }

  function openTaskEditor(snapshot = null) {
    state.authoringSnapshot = snapshot;
    nodes.taskEditorForm.reset();
    const editing = snapshot !== null;
    nodes.taskEditorTitle.textContent = editing
      ? '编辑命令任务'
      : '创建命令任务';
    nodes.taskEditorIntro.textContent = editing
      ? `完整定义已由本机证明读取，并绑定 revision ${snapshot.task.revision}。保存时还会生成一份只绑定新内容的证明。`
      : '定义会先绑定到一次本机证明，再以同一事务写入 Task revision 与安全审计。';
    nodes.taskEditorNote.textContent = editing
      ? `编辑租约将在 ${formatTime(
          snapshot.authoring.expiresAtMs,
        )} 失效；关闭后重新选择“编辑任务”可取得新快照。`
      : 'Alpha 当前从 Console 创建 qinglong/command@v1；高级 Task schema 仍使用受信任管理入口。';
    nodes.taskEnabledLabel.textContent = editing
      ? '保存后允许运行'
      : '创建后允许运行';
    nodes.taskId.readOnly = editing;
    if (editing) nodes.taskId.setAttribute('aria-readonly', 'true');
    else nodes.taskId.removeAttribute('aria-readonly');
    if (editing) {
      const command = snapshot.task.spec.config.command;
      nodes.taskId.value = snapshot.task.taskId;
      nodes.taskName.value = snapshot.task.name;
      nodes.taskDescription.value = snapshot.task.description || '';
      nodes.taskCommand.value = command.file;
      nodes.taskArgs.value = command.args.join('\n');
      nodes.taskEnabled.checked = snapshot.task.enabled;
    } else {
      nodes.taskCommand.value = '/bin/echo';
      nodes.taskEnabled.checked = true;
    }
    nodes.taskEditor.returnValue = '';
    nodes.taskEditor.showModal();
    (editing ? nodes.taskName : nodes.taskId).focus();
  }

  function authoringSnapshot(value, expectedTaskId) {
    const task = value?.task;
    const authoring = value?.authoring;
    const command = task?.spec?.config?.command;
    if (
      !task ||
      task.taskId !== expectedTaskId ||
      !Number.isSafeInteger(task.revision) ||
      task.revision < 1 ||
      typeof task.contentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(task.contentDigest) ||
      task.kind !== 'command' ||
      task.spec?.schema !== 'qinglong/command@v1' ||
      command?.kind !== 'argv' ||
      typeof command.file !== 'string' ||
      !Array.isArray(command.args) ||
      command.args.length > 128 ||
      command.args.some((entry) => typeof entry !== 'string') ||
      !task.labels ||
      typeof task.labels !== 'object' ||
      Array.isArray(task.labels) ||
      !authoring ||
      !AUTHORING_LEASE_PATTERN.test(authoring.lease) ||
      !Number.isSafeInteger(authoring.expiresAtMs) ||
      authoring.revision !== task.revision ||
      authoring.contentDigest !== task.contentDigest
    ) {
      throw new ConsoleRequestError('response_unavailable', 503, null);
    }
    return Object.freeze({ task, authoring });
  }

  function taskDraft() {
    const taskId = nodes.taskId.value.trim();
    const name = nodes.taskName.value.trim();
    const description = nodes.taskDescription.value.trim();
    const file = nodes.taskCommand.value.trim();
    const args = nodes.taskArgs.value
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (!TASK_PATTERN.test(taskId)) {
      throw new TypeError('Task ID 格式无效。');
    }
    if (!name || !file || args.length > 128) {
      throw new TypeError('名称、命令或参数数量无效。');
    }
    const snapshot = state.authoringSnapshot;
    const spec = snapshot
      ? Object.freeze({
          ...snapshot.task.spec,
          config: Object.freeze({
            ...snapshot.task.spec.config,
            command: Object.freeze({
              ...snapshot.task.spec.config.command,
              kind: 'argv',
              file,
              args,
            }),
          }),
        })
      : Object.freeze({
          schema: 'qinglong/command@v1',
          config: Object.freeze({
            command: Object.freeze({ kind: 'argv', file, args }),
          }),
        });
    return Object.freeze({
      taskId,
      ...(snapshot ? { authoringLease: snapshot.authoring.lease } : {}),
      body: Object.freeze({
        expectedRevision: snapshot ? snapshot.task.revision : null,
        mutationId: newMutationId(),
        name,
        ...(description ? { description } : {}),
        kind: 'command',
        spec,
        labels: snapshot
          ? snapshot.task.labels
          : Object.freeze({ 'qinglong.source': 'local-console' }),
        enabled: nodes.taskEnabled.checked,
        occurredAtMs: Date.now(),
      }),
    });
  }

  function openTriggerEditor(snapshot = null, task = null) {
    state.triggerSnapshot = snapshot;
    nodes.triggerEditorForm.reset();
    const editing = snapshot !== null;
    nodes.triggerEditorTitle.textContent = editing
      ? '编辑定时触发器'
      : '创建定时触发器';
    nodes.triggerEditorIntro.textContent = editing
      ? `将基于 Trigger revision ${snapshot.revision} 写入新 revision，并重新绑定 Task 当前内容。`
      : 'Trigger 会绑定 Task 当前 revision 与内容摘要；Task 改变后需重新保存定时配置。';
    nodes.triggerId.readOnly = editing;
    nodes.triggerTaskId.readOnly = editing;
    if (editing) {
      nodes.triggerId.setAttribute('aria-readonly', 'true');
      nodes.triggerTaskId.setAttribute('aria-readonly', 'true');
      nodes.triggerId.value = snapshot.triggerId;
      nodes.triggerTaskId.value = snapshot.taskId;
      nodes.triggerExpression.value = snapshot.spec.config.expression;
      nodes.triggerTimezone.value = snapshot.spec.config.timezone;
      nodes.triggerMisfire.value = snapshot.spec.config.misfirePolicy;
      nodes.triggerEnabled.checked = snapshot.enabled;
    } else {
      nodes.triggerId.removeAttribute('aria-readonly');
      nodes.triggerTaskId.removeAttribute('aria-readonly');
      nodes.triggerExpression.value = '0 * * * *';
      nodes.triggerTimezone.value = 'UTC';
      nodes.triggerMisfire.value = 'skip';
      nodes.triggerEnabled.checked = true;
      if (task) {
        nodes.triggerTaskId.value = task.taskId;
        nodes.triggerId.value = `cron:${task.taskId}`;
      }
    }
    nodes.triggerEditor.returnValue = '';
    nodes.triggerEditor.showModal();
    (editing || task ? nodes.triggerExpression : nodes.triggerId).focus();
  }

  async function triggerDraft() {
    const triggerId = nodes.triggerId.value.trim();
    const taskId = nodes.triggerTaskId.value.trim();
    const expression = nodes.triggerExpression.value
      .trim()
      .replace(/\s+/gu, ' ');
    const timezone = nodes.triggerTimezone.value.trim();
    const fields = expression.split(' ');
    if (!TASK_PATTERN.test(triggerId) || !TASK_PATTERN.test(taskId)) {
      throw new TypeError('Trigger ID 或 Task ID 格式无效。');
    }
    if (
      (fields.length !== 5 && fields.length !== 6) ||
      fields.some((field) => !CRON_FIELD_PATTERN.test(field)) ||
      !timezone
    ) {
      throw new TypeError('Cron 表达式或时区无效。');
    }
    const taskValue = await api(
      `/api/v3/projects/${state.project}/tasks/${taskId}`,
    );
    const task = taskValue.task;
    if (
      !task ||
      task.taskId !== taskId ||
      !Number.isSafeInteger(task.revision) ||
      !/^[a-f0-9]{64}$/u.test(task.contentDigest)
    ) {
      throw new ConsoleRequestError('response_unavailable', 503, null);
    }
    const snapshot = state.triggerSnapshot;
    return Object.freeze({
      triggerId,
      body: Object.freeze({
        expectedRevision: snapshot ? snapshot.revision : null,
        mutationId: newMutationId(),
        taskId,
        taskRevision: task.revision,
        taskContentDigest: task.contentDigest,
        spec: Object.freeze({
          schema: 'qinglong/cron@v1',
          config: Object.freeze({
            expression,
            timezone,
            misfirePolicy: nodes.triggerMisfire.value,
          }),
        }),
        enabled: nodes.triggerEnabled.checked,
        occurredAtMs: Date.now(),
      }),
    });
  }

  async function saveTriggerDraft() {
    nodes.triggerEditorSave.disabled = true;
    try {
      const mutation = await triggerDraft();
      const value = await api(
        `/api/v3/projects/${state.project}/triggers/${mutation.triggerId}`,
        {
          method: 'PUT',
          body: mutation.body,
          acceptStatus: 428,
        },
      );
      if (value.code === 'local_presence_required') {
        showPresenceChallenge({ kind: 'trigger-mutation', mutation }, value);
        return;
      }
      throw new ConsoleRequestError('response_unavailable', 503, null);
    } catch (error) {
      showToast(describeError(error), 'error');
    } finally {
      nodes.triggerEditorSave.disabled = false;
    }
  }

  function showPresenceChallenge(action, challenge) {
    if (
      challenge?.code !== 'local_presence_required' ||
      typeof challenge.proofFileName !== 'string' ||
      !/^[0-9a-f-]{36}\.json$/u.test(challenge.proofFileName) ||
      !Number.isSafeInteger(challenge.expiresAtMs)
    ) {
      throw new ConsoleRequestError('response_unavailable', 503, null);
    }
    state.pendingPresence = Object.freeze({ ...action, challenge });
    const authoringRead = action.kind === 'authoring';
    const triggerMutation = action.kind === 'trigger-mutation';
    nodes.presenceCopy.textContent = authoringRead
      ? '读取完整 Task 定义需要部署设备上的一次性证明。返回的编辑租约不替代保存时的新内容证明。'
      : triggerMutation
      ? '使用部署 QingLong 的系统用户读取下面的私有文件。证明只绑定这次 Trigger 与 Task revision，且只能使用一次。'
      : '使用部署 QingLong 的系统用户读取下面的私有文件。证明只绑定这次 Task 内容，且只能使用一次。';
    nodes.presenceSubmit.textContent = authoringRead
      ? '验证并加载定义'
      : action.mutation.body.expectedRevision === null
      ? '验证并创建'
      : '验证并更新';
    nodes.presenceFile.textContent = `console-presence/${challenge.proofFileName}`;
    nodes.presenceExpiry.textContent = `证明将在 ${formatTime(
      challenge.expiresAtMs,
    )} 失效；内容改变后必须重新生成。`;
    nodes.presenceProof.value = '';
    nodes.presenceError.textContent = '';
    nodes.presenceError.hidden = true;
    nodes.taskEditor.close();
    nodes.triggerEditor.close();
    nodes.presenceDialog.returnValue = '';
    nodes.presenceDialog.showModal();
    nodes.presenceProof.focus();
  }

  async function saveTaskDraft() {
    let mutation;
    try {
      mutation = taskDraft();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Task 定义无效。',
        'error',
      );
      return;
    }
    nodes.taskEditorSave.disabled = true;
    try {
      const value = await api(
        `/api/v3/projects/${state.project}/tasks/${mutation.taskId}`,
        {
          method: 'PUT',
          body: mutation.body,
          acceptStatus: 428,
          ...(mutation.authoringLease
            ? { authoringLease: mutation.authoringLease }
            : {}),
        },
      );
      if (value.code === 'local_presence_required') {
        showPresenceChallenge({ kind: 'mutation', mutation }, value);
        return;
      }
      throw new ConsoleRequestError('response_unavailable', 503, null);
    } catch (error) {
      showToast(describeError(error), 'error');
    } finally {
      nodes.taskEditorSave.disabled = false;
    }
  }

  async function beginTaskAuthoring(task) {
    try {
      const value = await api(
        `/api/v3/projects/${state.project}/tasks/${task.taskId}/authoring`,
        { method: 'POST', acceptStatus: 428 },
      );
      if (value.code === 'local_presence_required') {
        showPresenceChallenge(
          { kind: 'authoring', taskId: task.taskId },
          value,
        );
        return;
      }
      throw new ConsoleRequestError('response_unavailable', 503, null);
    } catch (error) {
      showToast(describeError(error), 'error');
    }
  }

  async function completeTaskMutation() {
    const pending = state.pendingPresence;
    const proof = nodes.presenceProof.value.trim();
    if (!pending || !PRESENCE_PATTERN.test(proof)) {
      nodes.presenceError.textContent =
        'proof 格式无效。请完整复制私有文件中的 proof 字段。';
      nodes.presenceError.hidden = false;
      nodes.presenceProof.focus();
      return;
    }
    nodes.presenceSubmit.disabled = true;
    nodes.presenceError.hidden = true;
    try {
      if (pending.kind === 'authoring') {
        const value = await api(
          `/api/v3/projects/${state.project}/tasks/${pending.taskId}/authoring`,
          { method: 'POST', presence: proof },
        );
        const snapshot = authoringSnapshot(value, pending.taskId);
        state.pendingPresence = null;
        nodes.presenceProof.value = '';
        nodes.presenceDialog.close();
        openTaskEditor(snapshot);
        showToast('完整 Task 定义已加载；保存仍需要新的本机证明。');
        return;
      }
      if (pending.kind === 'trigger-mutation') {
        const value = await api(
          `/api/v3/projects/${state.project}/triggers/${pending.mutation.triggerId}`,
          {
            method: 'PUT',
            body: pending.mutation.body,
            presence: proof,
          },
        );
        const updated = pending.mutation.body.expectedRevision !== null;
        state.pendingPresence = null;
        state.triggerSnapshot = null;
        nodes.presenceProof.value = '';
        nodes.presenceDialog.close();
        showToast(
          value.status === 'existing'
            ? '已找到同一 Trigger 请求。'
            : updated
            ? '定时触发器已更新。'
            : '定时触发器已创建。',
        );
        state.view = 'triggers';
        state.selectedId = pending.mutation.triggerId;
        updateNavigation();
        await refresh();
        await selectTrigger(pending.mutation.triggerId);
        return;
      }
      const value = await api(
        `/api/v3/projects/${state.project}/tasks/${pending.mutation.taskId}`,
        {
          method: 'PUT',
          body: pending.mutation.body,
          presence: proof,
          ...(pending.mutation.authoringLease
            ? { authoringLease: pending.mutation.authoringLease }
            : {}),
        },
      );
      const updated = pending.mutation.body.expectedRevision !== null;
      state.pendingPresence = null;
      state.authoringSnapshot = null;
      nodes.presenceProof.value = '';
      nodes.presenceDialog.close();
      showToast(
        value.status === 'existing'
          ? '已找到同一 Task 请求。'
          : updated
          ? 'Task 已更新。'
          : 'Task 已创建。',
      );
      state.selectedId = pending.mutation.taskId;
      await refresh();
      await selectTask(pending.mutation.taskId);
    } catch (error) {
      nodes.presenceError.textContent = describeError(error);
      nodes.presenceError.hidden = false;
      nodes.presenceProof.select();
    } finally {
      nodes.presenceSubmit.disabled = false;
    }
  }

  async function renderTasks() {
    const value = await api(`/api/v3/projects/${state.project}/tasks?limit=64`);
    const tasks = Array.isArray(value.tasks) ? value.tasks : [];
    if (tasks.length === 0) {
      empty('还没有可见任务。请先通过受信任的管理入口发布 Task。');
      return;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(listHeader('Task switchboard', tasks.length));
    const list = element('div', 'record-list');
    for (const task of tasks) {
      const button = element('button', 'record');
      button.type = 'button';
      button.dataset.identity = task.taskId;
      if (state.selectedId === task.taskId)
        button.setAttribute('aria-current', 'true');
      const main = element('span');
      main.append(element('span', 'record-title', task.name));
      main.append(
        recordMeta([
          task.taskId,
          `${task.kind} · rev ${task.revision}`,
          task.specSchema,
        ]),
      );
      const side = element('span', 'record-side');
      const enabled = element(
        'span',
        'status',
        task.enabled ? '可运行' : '已停用',
      );
      enabled.dataset.tone = task.enabled ? 'active' : 'quiet';
      side.append(enabled);
      side.append(element('span', 'record-time', formatTime(task.updatedAtMs)));
      button.append(main, side);
      button.addEventListener('click', () => selectTask(task.taskId));
      list.append(button);
    }
    fragment.append(list);
    if (value.hasMore) {
      fragment.append(
        element(
          'p',
          'privacy-note',
          '当前只展示前 64 条；完整分页将在后续 Console 切片开放。',
        ),
      );
    }
    replace(nodes.ledger, fragment);
  }

  async function selectTask(taskId) {
    state.selectedId = taskId;
    const selected = nodes.ledger.querySelectorAll('.record');
    for (const row of selected) {
      if (row.dataset.identity === taskId) {
        row.setAttribute('aria-current', 'true');
      } else {
        row.removeAttribute('aria-current');
      }
    }
    const loadingBox = element('div', 'loading-state');
    loadingBox.append(element('span'));
    replace(nodes.detail, loadingBox);
    try {
      const value = await api(
        `/api/v3/projects/${state.project}/tasks/${taskId}`,
      );
      renderTaskDetail(value.task);
    } catch (error) {
      detailEmpty(describeError(error));
    }
  }

  function renderTaskDetail(task) {
    const fragment = document.createDocumentFragment();
    fragment.append(detailHeader('Task definition', task.name, task.taskId));
    const facts = element('div', 'facts');
    facts.append(
      fact('状态', task.enabled ? '可运行' : '已停用'),
      fact('类型', task.kind),
      fact('Revision', task.revision),
      fact('Schema', task.specSchema),
      fact('Content fence', shortDigest(task.contentDigest)),
      fact('更新时间', formatTime(task.updatedAtMs)),
    );
    fragment.append(facts);
    const actions = element('div', 'detail-actions');
    if (task.kind === 'command' && task.specSchema === 'qinglong/command@v1') {
      actions.append(actionButton('编辑任务', () => beginTaskAuthoring(task)));
    }
    actions.append(
      actionButton('添加定时', () => openTriggerEditor(null, task)),
    );
    if (task.enabled) {
      actions.append(
        actionButton('运行一次', () => {
          confirmAction(
            '运行这个任务？',
            `将按 revision ${task.revision} 与当前内容摘要启动“${task.name}”。定义如有变化，服务端会拒绝本次操作。`,
            '确认运行',
            () => startTask(task),
          );
        }),
      );
    }
    fragment.append(actions);
    replace(nodes.detail, fragment);
  }

  async function startTask(task) {
    try {
      const value = await api(
        `/api/v3/projects/${state.project}/tasks/${task.taskId}/runs`,
        {
          method: 'POST',
          body: {
            schema: 'qinglong/task-start@v1',
            mutationId: newMutationId(),
            expectedRevision: task.revision,
            expectedContentDigest: task.contentDigest,
          },
        },
      );
      showToast(
        value.status === 'existing'
          ? '已找到同一启动请求。'
          : '任务已进入运行队列。',
      );
      state.view = 'runs';
      state.selectedId = value.runId;
      updateNavigation();
      await refresh();
      await selectRun(value.runId);
    } catch (error) {
      showToast(describeError(error), 'error');
    }
  }

  async function renderTriggers() {
    const value = await api(
      `/api/v3/projects/${state.project}/triggers?limit=64`,
    );
    const triggers = Array.isArray(value.triggers) ? value.triggers : [];
    if (triggers.length === 0) {
      empty('还没有定时触发器。创建后，现有本地调度器会按 cron 自动生成 Run。');
      return;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(listHeader('Cron trigger ledger', triggers.length));
    const list = element('div', 'record-list');
    for (const trigger of triggers) {
      const button = element('button', 'record');
      button.type = 'button';
      button.dataset.identity = trigger.triggerId;
      if (state.selectedId === trigger.triggerId) {
        button.setAttribute('aria-current', 'true');
      }
      const main = element('span');
      main.append(element('span', 'record-title', trigger.triggerId));
      main.append(
        recordMeta([
          trigger.taskId,
          `trigger rev ${trigger.revision}`,
          `task rev ${trigger.taskRevision}`,
        ]),
      );
      const side = element('span', 'record-side');
      const enabled = element(
        'span',
        'status',
        trigger.enabled ? '自动执行' : '已停用',
      );
      enabled.dataset.tone = trigger.enabled ? 'active' : 'quiet';
      side.append(enabled);
      side.append(
        element('span', 'record-time', formatTime(trigger.updatedAtMs)),
      );
      button.append(main, side);
      button.addEventListener('click', () => selectTrigger(trigger.triggerId));
      list.append(button);
    }
    fragment.append(list);
    if (value.truncated) {
      fragment.append(
        element(
          'p',
          'privacy-note',
          '当前只展示前 64 条；使用 API 可继续读取下一页。',
        ),
      );
    }
    replace(nodes.ledger, fragment);
  }

  async function selectTrigger(triggerId) {
    state.selectedId = triggerId;
    for (const row of nodes.ledger.querySelectorAll('.record')) {
      if (row.dataset.identity === triggerId) {
        row.setAttribute('aria-current', 'true');
      } else {
        row.removeAttribute('aria-current');
      }
    }
    const loadingBox = element('div', 'loading-state');
    loadingBox.append(element('span'));
    replace(nodes.detail, loadingBox);
    try {
      const value = await api(
        `/api/v3/projects/${state.project}/triggers/${triggerId}`,
      );
      renderTriggerDetail(value.trigger);
    } catch (error) {
      detailEmpty(describeError(error));
    }
  }

  function renderTriggerDetail(trigger) {
    const config = trigger?.spec?.config;
    const fragment = document.createDocumentFragment();
    fragment.append(
      detailHeader('Cron trigger', trigger.triggerId, trigger.taskId),
    );
    const facts = element('div', 'facts');
    facts.append(
      fact('状态', trigger.enabled ? '自动执行' : '已停用'),
      fact('Revision', trigger.revision),
      fact('Cron', config?.expression || '—'),
      fact('时区', config?.timezone || '—'),
      fact('Misfire', config?.misfirePolicy || '—'),
      fact(
        'Task fence',
        `rev ${trigger.taskRevision} · ${shortDigest(
          trigger.taskContentDigest,
        )}`,
      ),
      fact('Content fence', shortDigest(trigger.contentDigest)),
      fact('更新时间', formatTime(trigger.updatedAtMs)),
    );
    fragment.append(facts);
    const actions = element('div', 'detail-actions');
    if (trigger.spec?.schema === 'qinglong/cron@v1') {
      actions.append(
        actionButton('编辑或停用', () => openTriggerEditor(trigger)),
      );
    }
    actions.append(
      actionButton('查看绑定任务', async () => {
        state.view = 'tasks';
        state.selectedId = trigger.taskId;
        updateNavigation();
        await refresh();
        await selectTask(trigger.taskId);
      }),
    );
    fragment.append(actions);
    replace(nodes.detail, fragment);
  }

  async function renderRuns() {
    const value = await api(`/api/v3/projects/${state.project}/runs?limit=64`);
    const runs = Array.isArray(value.runs) ? value.runs : [];
    if (runs.length === 0) {
      empty('还没有运行记录。切换到任务，选择一个已启用 Task 开始运行。');
      return;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(listHeader('Run ledger', runs.length));
    const list = element('div', 'record-list');
    for (const run of runs) {
      const button = element('button', 'record');
      button.type = 'button';
      button.dataset.identity = run.id;
      if (state.selectedId === run.id)
        button.setAttribute('aria-current', 'true');
      const main = element('span');
      main.append(element('span', 'record-title', run.taskId));
      main.append(
        recordMeta([
          run.id,
          `rev ${run.taskRevision}`,
          `${run.executionOrigin} / ${run.executionOwner}`,
        ]),
      );
      const side = element('span', 'record-side');
      side.append(statusBadge(run.status));
      side.append(element('span', 'record-time', formatTime(run.createdAtMs)));
      button.append(main, side);
      button.addEventListener('click', () => selectRun(run.id));
      list.append(button);
    }
    fragment.append(list);
    if (value.hasMore) {
      fragment.append(
        element(
          'p',
          'privacy-note',
          '当前只展示最近 64 条；使用 API 可继续读取下一页。',
        ),
      );
    }
    replace(nodes.ledger, fragment);
  }

  async function selectRun(runId) {
    state.selectedId = runId;
    const selected = nodes.ledger.querySelectorAll('.record');
    for (const row of selected) {
      if (row.dataset.identity === runId) {
        row.setAttribute('aria-current', 'true');
      } else {
        row.removeAttribute('aria-current');
      }
    }
    const loadingBox = element('div', 'loading-state');
    loadingBox.append(element('span'));
    replace(nodes.detail, loadingBox);
    try {
      const [runValue, eventValue, stepValue] = await Promise.all([
        api(`/api/v3/projects/${state.project}/runs/${runId}`),
        api(`/api/v3/projects/${state.project}/runs/${runId}/events?limit=64`),
        api(`/api/v3/projects/${state.project}/runs/${runId}/steps?limit=64`),
      ]);
      const logView = await readRunLog(runValue.run);
      renderRunDetail(runValue.run, eventValue, stepValue, logView);
    } catch (error) {
      detailEmpty(describeError(error));
    }
  }

  async function readRunLog(run) {
    const attempt = run?.latestAttempt;
    if (!attempt || typeof attempt.id !== 'string') {
      return Object.freeze({ status: 'not_started' });
    }
    try {
      const value = await api(
        `/api/v3/projects/${state.project}/runs/${run.id}/attempts/${attempt.id}/log?offset=0&length=${LOG_READ_BYTES}`,
      );
      if (value.status === 'pending') {
        return Object.freeze({ status: 'pending', attempt });
      }
      const content =
        value.status === 'available' && value.encoding === 'base64'
          ? decodeBase64Utf8(value.content)
          : null;
      if (
        content === null ||
        !value.range ||
        !Number.isSafeInteger(value.range.start) ||
        !Number.isSafeInteger(value.range.endExclusive) ||
        !Number.isSafeInteger(value.range.totalBytes)
      ) {
        return Object.freeze({ status: 'unavailable', attempt });
      }
      return Object.freeze({
        status: 'available',
        attempt,
        content,
        range: value.range,
        truncation: value.truncation,
      });
    } catch (error) {
      if (error instanceof ConsoleRequestError && error.status === 410) {
        return Object.freeze({ status: 'retired', attempt });
      }
      if (error instanceof ConsoleRequestError && error.status === 404) {
        return Object.freeze({ status: 'not_found', attempt });
      }
      return Object.freeze({ status: 'unavailable', attempt });
    }
  }

  function renderRunLog(logView) {
    const section = element('section', 'run-log');
    section.dataset.state = logView.status;
    const header = element('div', 'run-log-header');
    header.append(element('strong', null, 'Bounded log'));
    if (logView.attempt) {
      header.append(
        element(
          'span',
          null,
          `Attempt ${logView.attempt.attempt} · ${logView.attempt.status}`,
        ),
      );
    }
    section.append(header);
    if (logView.status === 'available') {
      const metadata = [
        `${logView.range.start}–${logView.range.endExclusive} / ${logView.range.totalBytes} bytes`,
      ];
      if (logView.truncation?.truncated === true) metadata.push('执行端已截断');
      if (logView.truncation?.truncated === 'unknown')
        metadata.push('截断状态未知');
      if (logView.range.nextOffset !== undefined)
        metadata.push('后续内容可经 API 分页读取');
      section.append(element('p', 'run-log-meta', metadata.join(' · ')));
      section.append(
        element('pre', 'run-log-content', logView.content || '（空日志）'),
      );
      return section;
    }
    const labels = {
      not_started: '当前 Run 还没有可读取的执行 Attempt。',
      pending: '日志尚未发布；运行中可使用“刷新”重新读取。',
      retired: '日志已按保留策略清理，Run 与 Event 事实仍然保留。',
      not_found: '当前 Project 下没有找到这份 Attempt 日志。',
      unavailable: '日志暂时不可用；Run 状态与 Event 仍可独立核验。',
    };
    section.append(
      element(
        'p',
        'run-log-placeholder',
        labels[logView.status] || labels.unavailable,
      ),
    );
    return section;
  }

  function renderRunDetail(run, eventPage, stepPage, logView) {
    const events = Array.isArray(eventPage.events) ? eventPage.events : [];
    const steps = Array.isArray(stepPage.steps) ? stepPage.steps : [];
    const fragment = document.createDocumentFragment();
    fragment.append(detailHeader('Run evidence', run.taskId, run.id));
    const facts = element('div', 'facts');
    facts.append(
      fact('状态', STATUS_LABELS[run.status] || run.status),
      fact('Version', run.version),
      fact('事件', run.eventSequence),
      fact('Workflow steps', steps.length),
      fact('执行归属', run.executionOwner),
      fact('创建时间', formatTime(run.createdAtMs)),
    );
    fragment.append(facts);
    if (!TERMINAL.has(run.status) && run.status !== 'cancel_requested') {
      const actions = element('div', 'detail-actions');
      actions.append(
        actionButton(
          '请求取消',
          () => {
            confirmAction(
              '请求取消运行？',
              '取消请求会先写入 durable intent。正在执行的进程只有在安全控制链确认后才会停止。',
              '确认请求取消',
              () => cancelRun(run),
              true,
            );
          },
          'danger',
        ),
      );
      fragment.append(actions);
    }
    fragment.append(renderRunLog(logView));
    fragment.append(element('h4', 'timeline-heading', 'Event sequence'));
    if (events.length === 0) {
      fragment.append(element('p', 'privacy-note', '当前窗口没有可见事件。'));
    } else {
      const timeline = element('ol', 'event-spine');
      for (const event of events) {
        const item = element('li', 'event');
        item.append(element('span', 'event-sequence', event.sequence));
        const copy = element('div');
        copy.append(element('strong', null, event.type));
        copy.append(
          element(
            'span',
            null,
            `${event.actorType} · ${formatTime(event.createdAtMs)}`,
          ),
        );
        item.append(copy);
        timeline.append(item);
      }
      fragment.append(timeline);
    }
    if (eventPage.hasMore || stepPage.hasMore) {
      fragment.append(
        element(
          'p',
          'privacy-note',
          '详情超过当前 64 条窗口；完整证据可通过 API 分页读取。',
        ),
      );
    }
    replace(nodes.detail, fragment);
  }

  async function cancelRun(run) {
    try {
      const value = await api(
        `/api/v3/projects/${state.project}/runs/${run.id}/cancellation`,
        {
          method: 'POST',
          body: {
            schema: 'qinglong/run-cancellation@v1',
            mutationId: newMutationId(),
          },
        },
      );
      showToast(
        value.status === 'already_terminal'
          ? '运行已经结束。'
          : value.status === 'already_requested'
          ? '取消请求已经存在。'
          : '取消请求已写入。',
      );
      await refresh();
      await selectRun(run.id);
    } catch (error) {
      showToast(describeError(error), 'error');
    }
  }

  function updateNavigation() {
    for (const button of nodes.nav.querySelectorAll('button[data-view]')) {
      if (button.dataset.view === state.view)
        button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (state.view === 'tasks') {
      nodes.createTask.hidden = false;
      nodes.createTrigger.hidden = true;
      nodes.kicker.textContent = 'Project task authority';
      nodes.title.textContent = '任务调度台';
      nodes.description.textContent =
        '创建命令 Task，查看当前 revision 与内容围栏。管理写入需要部署设备上的一次性本机证明。';
    } else if (state.view === 'triggers') {
      nodes.createTask.hidden = true;
      nodes.createTrigger.hidden = false;
      nodes.kicker.textContent = 'Durable cron authority';
      nodes.title.textContent = '定时触发器';
      nodes.description.textContent =
        '配置内置 cron Trigger，绑定 Task 当前 revision；停用只追加历史，不删除证据。';
    } else {
      nodes.createTask.hidden = true;
      nodes.createTrigger.hidden = true;
      nodes.kicker.textContent = 'Durable run evidence';
      nodes.title.textContent = '运行事实账本';
      nodes.description.textContent =
        '状态来自持久化 Run；取消只是请求，只有终态事件才能证明执行已经停止。';
    }
  }

  async function refresh() {
    if (!state.token) return;
    loading();
    try {
      if (state.view === 'tasks') await renderTasks();
      else if (state.view === 'triggers') await renderTriggers();
      else await renderRuns();
      setConnection('connected', `${state.project} · 已连接`);
    } catch (error) {
      errorState(error);
    } finally {
      setBusy(false);
    }
  }

  function connect(token, project) {
    state.token = token;
    state.project = project;
    state.view = 'tasks';
    state.selectedId = null;
    nodes.token.value = '';
    nodes.token.disabled = true;
    nodes.project.disabled = true;
    nodes.form.querySelector('.primary-button').hidden = true;
    nodes.disconnect.hidden = false;
    nodes.nav.hidden = false;
    nodes.refresh.hidden = false;
    detailEmpty();
    updateNavigation();
    setConnection('connected', `${project} · 正在验证`);
    refresh();
  }

  function disconnect() {
    state.token = null;
    state.selectedId = null;
    state.pendingAction = null;
    state.pendingPresence = null;
    state.authoringSnapshot = null;
    state.triggerSnapshot = null;
    if (nodes.taskEditor.open) nodes.taskEditor.close();
    if (nodes.triggerEditor.open) nodes.triggerEditor.close();
    if (nodes.presenceDialog.open) nodes.presenceDialog.close();
    nodes.token.value = '';
    nodes.token.disabled = false;
    nodes.project.disabled = false;
    nodes.form.querySelector('.primary-button').hidden = false;
    nodes.disconnect.hidden = true;
    nodes.nav.hidden = true;
    nodes.refresh.hidden = true;
    nodes.createTask.hidden = true;
    nodes.createTrigger.hidden = true;
    setConnection('idle', '等待凭据');
    nodes.kicker.textContent = 'Connection gate';
    nodes.title.textContent = '先建立一条本机连接';
    nodes.description.textContent =
      '输入 quickstart 交付的 Owner API Credential。连接成功后才能读取或执行操作。';
    const welcome = element('div', 'welcome-state');
    welcome.append(element('span', 'welcome-index', 'QL / 03'));
    welcome.append(element('p', null, '任务是计划，运行是事实，事件是证据。'));
    const rule = element('div', 'welcome-rule');
    rule.setAttribute('aria-hidden', 'true');
    rule.append(element('i'), element('i'), element('i'));
    welcome.append(rule);
    replace(nodes.ledger, welcome);
    detailEmpty();
    nodes.token.focus();
  }

  nodes.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = nodes.token.value.trim();
    const project = nodes.project.value.trim();
    if (!PROJECT_PATTERN.test(project)) {
      showToast('项目 ID 格式无效。', 'error');
      nodes.project.focus();
      return;
    }
    if (!TOKEN_PATTERN.test(token)) {
      showToast('API Credential 格式无效。', 'error');
      nodes.token.focus();
      return;
    }
    connect(token, project);
  });

  nodes.disconnect.addEventListener('click', disconnect);
  nodes.refresh.addEventListener('click', refresh);
  nodes.createTask.addEventListener('click', () => openTaskEditor());
  nodes.createTrigger.addEventListener('click', () => openTriggerEditor());
  nodes.taskEditorClose.addEventListener('click', () => {
    state.authoringSnapshot = null;
    nodes.taskEditor.close();
  });
  nodes.taskEditorForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveTaskDraft();
  });
  nodes.triggerEditorClose.addEventListener('click', () => {
    state.triggerSnapshot = null;
    nodes.triggerEditor.close();
  });
  nodes.triggerEditorForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveTriggerDraft();
  });
  nodes.presenceCancel.addEventListener('click', () => {
    state.pendingPresence = null;
    state.authoringSnapshot = null;
    state.triggerSnapshot = null;
    nodes.presenceProof.value = '';
    nodes.presenceDialog.close();
  });
  nodes.presenceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await completeTaskMutation();
  });

  for (const button of nodes.nav.querySelectorAll('button[data-view]')) {
    button.addEventListener('click', () => {
      if (button.dataset.view === state.view) return;
      state.view = button.dataset.view;
      state.selectedId = null;
      detailEmpty();
      updateNavigation();
      refresh();
    });
  }

  nodes.dialog.addEventListener('close', async () => {
    const action = state.pendingAction;
    state.pendingAction = null;
    if (nodes.dialog.returnValue === 'accept' && typeof action === 'function') {
      await action();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (
      !state.token ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      nodes.dialog.open ||
      nodes.taskEditor.open ||
      nodes.triggerEditor.open ||
      nodes.presenceDialog.open
    ) {
      return;
    }
    const view =
      event.key.toLowerCase() === 't'
        ? 'tasks'
        : event.key.toLowerCase() === 's'
        ? 'triggers'
        : event.key.toLowerCase() === 'r'
        ? 'runs'
        : null;
    if (!view || view === state.view) return;
    state.view = view;
    state.selectedId = null;
    detailEmpty();
    updateNavigation();
    refresh();
  });
})();
