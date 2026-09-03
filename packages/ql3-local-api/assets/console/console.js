(() => {
  'use strict';

  const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const SECRET_REF_PREFIX = 'qlsecret:v1:';
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
    secret_query_unavailable: 'Secret 元数据暂时不可读取。请检查数据库状态。',
    secret_fence_rejected:
      'Secret、凭据或授权在确认期间发生变化。请刷新后重新保存。',
    invalid_secret: 'Secret 名称、版本或明文无效。',
    secret_unavailable: 'Secret 暂时无法加密保存。请检查密钥与数据库状态。',
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
    createSecret: document.getElementById('create-secret-button'),
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
    taskSecretBindings: document.getElementById('task-secret-bindings-input'),
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
    secretEditor: document.getElementById('secret-editor-dialog'),
    secretEditorTitle: document.getElementById('secret-editor-title'),
    secretEditorIntro: document.getElementById('secret-editor-intro'),
    secretEditorNote: document.getElementById('secret-editor-note'),
    secretEditorForm: document.getElementById('secret-editor-form'),
    secretEditorClose: document.getElementById('secret-editor-close'),
    secretEditorSave: document.getElementById('secret-editor-save'),
    secretName: document.getElementById('secret-name-input'),
    secretValue: document.getElementById('secret-value-input'),
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
    secretSnapshot: null,
    secretCatalog: [],
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

  function encodeBase64UrlUtf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return window
      .btoa(binary)
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/gu, '');
  }

  function decodeBase64UrlUtf8(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new TypeError('SecretRef 编码无效。');
    }
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const binary = window.atob(
      value.replace(/-/gu, '+').replace(/_/gu, '/') + padding,
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function createSecretRef(projectId, name, version) {
    const payload = JSON.stringify({ projectId, name, version });
    const result = `${SECRET_REF_PREFIX}${encodeBase64UrlUtf8(payload)}`;
    if (result.length > 512) throw new TypeError('SecretRef 过长。');
    return result;
  }

  function parseSecretRef(value) {
    if (
      typeof value !== 'string' ||
      value.length > 512 ||
      !value.startsWith(SECRET_REF_PREFIX)
    ) {
      throw new TypeError('SecretRef 无效。');
    }
    const encoded = value.slice(SECRET_REF_PREFIX.length);
    const parsed = JSON.parse(decodeBase64UrlUtf8(encoded));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'name,projectId,version' ||
      typeof parsed.projectId !== 'string' ||
      typeof parsed.name !== 'string' ||
      !Number.isSafeInteger(parsed.version) ||
      parsed.version < 1 ||
      createSecretRef(parsed.projectId, parsed.name, parsed.version) !== value
    ) {
      throw new TypeError('SecretRef 无效。');
    }
    return Object.freeze(parsed);
  }

  function isValidSecretName(value) {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      new TextEncoder().encode(value).length <= 128 &&
      !/[\u0000-\u001f\u007f]/u.test(value)
    );
  }

  function secretBindingsFromTask(task) {
    const environment = task?.spec?.config?.environment;
    if (environment === undefined) return '';
    if (!Array.isArray(environment) || environment.length > 256) {
      throw new TypeError('Task 环境变量定义无效。');
    }
    return environment
      .filter((entry) => entry?.kind === 'secret')
      .map((entry) => {
        const reference = parseSecretRef(entry.secretRef);
        if (
          !ENVIRONMENT_NAME_PATTERN.test(entry.name) ||
          entry.name.startsWith('QL3_') ||
          reference.projectId !== state.project ||
          !TASK_PATTERN.test(reference.name)
        ) {
          throw new TypeError(
            '当前 Task 包含 Console 无法安全编辑的 Secret 绑定。',
          );
        }
        return `${entry.name}=${reference.name}@${reference.version}`;
      })
      .join('\n');
  }

  function parseSecretBindings(value) {
    const entries = [];
    const names = new Set();
    const lines = value
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (lines.length > 256) throw new TypeError('Secret 绑定不能超过 256 条。');
    for (const line of lines) {
      const match =
        /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:@([1-9][0-9]{0,9}))?$/u.exec(
          line,
        );
      if (!match || match[1].startsWith('QL3_') || names.has(match[1])) {
        throw new TypeError(`Secret 绑定无效：${line}`);
      }
      const available = state.secretCatalog.find(
        (secret) => secret.name === match[2],
      );
      const version = match[3] ? Number(match[3]) : available?.currentVersion;
      if (
        !available ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > available.currentVersion
      ) {
        throw new TypeError(`找不到 Secret 当前版本：${match[2]}`);
      }
      names.add(match[1]);
      entries.push(
        Object.freeze({
          name: match[1],
          kind: 'secret',
          secretRef: createSecretRef(state.project, match[2], version),
        }),
      );
    }
    return Object.freeze(entries);
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
    const secretHint =
      state.secretCatalog.length === 0
        ? '当前没有可绑定 Secret；可先到“凭据”创建。'
        : `当前可绑定：${state.secretCatalog
            .map((secret) => `${secret.name}@${secret.currentVersion}`)
            .join('、')}`;
    nodes.taskEditorNote.textContent = editing
      ? `编辑租约将在 ${formatTime(
          snapshot.authoring.expiresAtMs,
        )} 失效。${secretHint}`
      : `Console 创建 qinglong/command@v1。${secretHint}`;
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
      nodes.taskSecretBindings.value = secretBindingsFromTask(snapshot.task);
      nodes.taskEnabled.checked = snapshot.task.enabled;
    } else {
      nodes.taskCommand.value = '/bin/echo';
      nodes.taskSecretBindings.value = '';
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
    const secretEnvironment = parseSecretBindings(
      nodes.taskSecretBindings.value,
    );
    if (!TASK_PATTERN.test(taskId)) {
      throw new TypeError('Task ID 格式无效。');
    }
    if (!name || !file || args.length > 128) {
      throw new TypeError('名称、命令或参数数量无效。');
    }
    const snapshot = state.authoringSnapshot;
    const publicEnvironment = snapshot
      ? (snapshot.task.spec.config.environment || []).filter(
          (entry) => entry?.kind === 'public',
        )
      : [];
    const environment = Object.freeze([
      ...publicEnvironment,
      ...secretEnvironment,
    ]);
    if (environment.length > 256) {
      throw new TypeError('环境变量总数不能超过 256 条。');
    }
    const spec = snapshot
      ? Object.freeze({
          ...snapshot.task.spec,
          config: Object.freeze({
            ...snapshot.task.spec.config,
            environment,
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
            environment,
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

  function normalizeSecretMetadata(value) {
    const secrets = Array.isArray(value?.secrets) ? value.secrets : null;
    if (
      !secrets ||
      secrets.length > 64 ||
      secrets.some((secret) => {
        if (
          !secret ||
          !isValidSecretName(secret.name) ||
          !Number.isSafeInteger(secret.currentVersion) ||
          secret.currentVersion < 1 ||
          !Number.isSafeInteger(secret.createdAtMs) ||
          secret.createdAtMs < 0
        ) {
          return true;
        }
        const reference = parseSecretRef(secret.secretRef);
        return (
          reference.projectId !== state.project ||
          reference.name !== secret.name ||
          reference.version !== secret.currentVersion
        );
      })
    ) {
      throw new ConsoleRequestError('response_unavailable', 503, null);
    }
    return Object.freeze(secrets.map((secret) => Object.freeze(secret)));
  }

  async function loadSecretCatalog() {
    const value = await api(
      `/api/v3/projects/${state.project}/secrets?limit=64`,
    );
    state.secretCatalog = normalizeSecretMetadata(value);
    return Object.freeze({
      secrets: state.secretCatalog,
      truncated: value.truncated === true,
    });
  }

  function openSecretEditor(snapshot = null) {
    state.secretSnapshot = snapshot;
    nodes.secretEditorForm.reset();
    const rotating = snapshot !== null;
    nodes.secretEditorTitle.textContent = rotating
      ? '轮换加密凭据'
      : '创建加密凭据';
    nodes.secretEditorIntro.textContent = rotating
      ? `新值将写入 ${snapshot.name} 的 version ${
          snapshot.currentVersion + 1
        }；已有 Task 仍固定使用旧版本。`
      : '明文只在当前页面内存和本次 loopback 请求中短暂存在；服务端只持久化 AES-256-GCM 密文。';
    nodes.secretEditorNote.textContent = rotating
      ? '轮换不会悄悄改变现有自动化；请编辑 Task 明确切换到新版本。'
      : '保存需要一次性本机证明；API、审计、Console 与日志都不会返回明文。';
    nodes.secretName.readOnly = rotating;
    if (rotating) {
      nodes.secretName.setAttribute('aria-readonly', 'true');
      nodes.secretName.value = snapshot.name;
    } else {
      nodes.secretName.removeAttribute('aria-readonly');
    }
    nodes.secretValue.value = '';
    nodes.secretEditor.returnValue = '';
    nodes.secretEditor.showModal();
    (rotating ? nodes.secretValue : nodes.secretName).focus();
  }

  function secretDraft() {
    const name = nodes.secretName.value.trim();
    const plaintext = nodes.secretValue.value;
    nodes.secretValue.value = '';
    if (!TASK_PATTERN.test(name)) {
      throw new TypeError('Secret 名称格式无效。');
    }
    if (!plaintext || new TextEncoder().encode(plaintext).length > 16 * 1024) {
      throw new TypeError('Secret 新值必须为 1–16384 bytes。');
    }
    return Object.freeze({
      name,
      plaintext,
      mutationId: newMutationId(),
      expectedCurrentVersion: state.secretSnapshot?.currentVersion || 0,
    });
  }

  async function saveSecretDraft() {
    let body;
    try {
      body = secretDraft();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Secret 定义无效。',
        'error',
      );
      return;
    }
    nodes.secretEditorSave.disabled = true;
    try {
      const value = await api(`/api/v3/projects/${state.project}/secrets`, {
        method: 'PUT',
        body,
        acceptStatus: 428,
      });
      if (value.code === 'local_presence_required') {
        showPresenceChallenge({ kind: 'secret-mutation', body }, value);
        return;
      }
      throw new ConsoleRequestError('response_unavailable', 503, null);
    } catch (error) {
      body = null;
      showToast(describeError(error), 'error');
    } finally {
      nodes.secretEditorSave.disabled = false;
    }
  }

  async function renderSecrets(request) {
    const response = await api(
      `/api/v3/projects/${request.project}/secrets?limit=64`,
    );
    if (!request.isCurrent()) return;
    state.secretCatalog = normalizeSecretMetadata(response);
    const value = {
      secrets: state.secretCatalog,
      truncated: response.truncated === true,
    };
    if (value.secrets.length === 0) {
      empty('还没有加密 Secret。创建后可在命令 Task 中绑定固定版本。');
      return;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(
      listHeader('Encrypted Secret catalog', value.secrets.length),
    );
    const list = element('div', 'record-list');
    for (const secret of value.secrets) {
      const button = element('button', 'record');
      button.type = 'button';
      button.dataset.identity = secret.name;
      if (state.selectedId === secret.name) {
        button.setAttribute('aria-current', 'true');
      }
      const main = element('span');
      main.append(element('span', 'record-title', secret.name));
      main.append(
        recordMeta([`version ${secret.currentVersion}`, 'AES-256-GCM']),
      );
      const side = element('span', 'record-side');
      const status = element('span', 'status', '已加密');
      status.dataset.tone = 'active';
      side.append(status);
      side.append(
        element('span', 'record-time', formatTime(secret.createdAtMs)),
      );
      button.append(main, side);
      button.addEventListener('click', () => selectSecret(secret.name));
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

  function selectSecret(name) {
    state.selectedId = name;
    for (const row of nodes.ledger.querySelectorAll('.record')) {
      if (row.dataset.identity === name)
        row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    const secret = state.secretCatalog.find((entry) => entry.name === name);
    if (!secret) {
      detailEmpty('Secret 元数据已变化，请刷新后重试。');
      return;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(detailHeader('Encrypted Secret', secret.name, secret.name));
    const facts = element('div', 'facts');
    facts.append(
      fact('当前版本', secret.currentVersion),
      fact('存储', 'AES-256-GCM 密文'),
      fact('Pinned ref', shortDigest(secret.secretRef)),
      fact('版本时间', formatTime(secret.createdAtMs)),
    );
    fragment.append(facts);
    const actions = element('div', 'detail-actions');
    actions.append(actionButton('轮换新版本', () => openSecretEditor(secret)));
    fragment.append(actions);
    fragment.append(
      element(
        'p',
        'privacy-note',
        'Task 只绑定固定版本；轮换后必须显式编辑 Task 才会采用新值。明文永不从此接口返回。',
      ),
    );
    replace(nodes.detail, fragment);
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
    const secretMutation = action.kind === 'secret-mutation';
    nodes.presenceCopy.textContent = authoringRead
      ? '读取完整 Task 定义需要部署设备上的一次性证明。返回的编辑租约不替代保存时的新内容证明。'
      : triggerMutation
      ? '使用部署 QingLong 的系统用户读取下面的私有文件。证明只绑定这次 Trigger 与 Task revision，且只能使用一次。'
      : secretMutation
      ? '使用部署 QingLong 的系统用户读取下面的私有文件。证明绑定这次 Secret 内容摘要、当前版本和 User Credential，且只能使用一次。'
      : '使用部署 QingLong 的系统用户读取下面的私有文件。证明只绑定这次 Task 内容，且只能使用一次。';
    nodes.presenceSubmit.textContent = authoringRead
      ? '验证并加载定义'
      : secretMutation
      ? action.body.expectedCurrentVersion === 0
        ? '验证并加密创建'
        : '验证并轮换版本'
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
    nodes.secretEditor.close();
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
        try {
          await loadSecretCatalog();
        } catch {
          state.secretCatalog = [];
          showToast(
            'Task 已加载，但 Secret 目录暂不可用；已有绑定仍会保留。',
            'error',
          );
        }
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
      if (pending.kind === 'secret-mutation') {
        const value = await api(`/api/v3/projects/${state.project}/secrets`, {
          method: 'PUT',
          body: pending.body,
          presence: proof,
        });
        const rotated = pending.body.expectedCurrentVersion > 0;
        state.pendingPresence = null;
        state.secretSnapshot = null;
        nodes.secretValue.value = '';
        nodes.presenceProof.value = '';
        nodes.presenceDialog.close();
        showToast(
          value.status === 'existing'
            ? '已找到同一 Secret 请求。'
            : rotated
            ? `Secret 已轮换到 version ${value.secret.currentVersion}。`
            : 'Secret 已加密创建。',
        );
        state.view = 'secrets';
        state.selectedId = pending.body.name;
        updateNavigation();
        await refresh();
        selectSecret(pending.body.name);
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

  function ledgerCursor(view, value) {
    const field =
      view === 'runs' ? 'runId' : view === 'tasks' ? 'taskId' : 'triggerId';
    const keys = view === 'runs' ? [field, 'createdAtMs'] : [field];
    if (
      !value ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key)) ||
      typeof value[field] !== 'string' ||
      !TASK_PATTERN.test(value[field]) ||
      (view === 'runs' &&
        (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0))
    ) {
      throw new TypeError('列表分页边界无效，请回到首页重新读取。');
    }
    return view === 'runs'
      ? { runId: value.runId, createdAtMs: value.createdAtMs }
      : { [field]: value[field] };
  }

  function ledgerCursorFollows(view, cursor, previous) {
    if (!previous) return true;
    if (view === 'runs')
      return (
        cursor.createdAtMs < previous.createdAtMs ||
        (cursor.createdAtMs === previous.createdAtMs &&
          cursor.runId < previous.runId)
      );
    const field = view === 'tasks' ? 'taskId' : 'triggerId';
    return cursor[field] > previous[field];
  }

  async function readLedgerPage(request) {
    const { view, project, after } = request;
    let query = 'limit=64';
    if (after) {
      const cursor = ledgerCursor(view, after);
      // The HTTP contract accepts canonical ASCII IDs, not percent-encoded aliases.
      query +=
        view === 'runs'
          ? `&after_created_at_ms=${cursor.createdAtMs}&after_run_id=${cursor.runId}`
          : view === 'tasks'
          ? `&after_task_id=${cursor.taskId}`
          : `&after_trigger_id=${cursor.triggerId}`;
    }
    const value = await api(`/api/v3/projects/${project}/${view}?${query}`);
    if (!request.isCurrent()) return null;
    const rows = value[view];
    const hasMore = view === 'triggers' ? value.truncated : value.hasMore;
    if (
      !Array.isArray(rows) ||
      rows.length > 64 ||
      typeof hasMore !== 'boolean'
    ) {
      throw new TypeError('列表响应无效，请重新读取。');
    }
    let boundary = after;
    for (const row of rows) {
      const cursor = ledgerCursor(
        view,
        view === 'runs'
          ? { runId: row?.id, createdAtMs: row?.createdAtMs }
          : view === 'tasks'
          ? { taskId: row?.taskId }
          : { triggerId: row?.triggerId },
      );
      if (!ledgerCursorFollows(view, cursor, boundary)) {
        throw new TypeError('列表顺序或分页边界发生异常，请回到首页。');
      }
      boundary = cursor;
    }
    let next = null;
    if (hasMore) {
      next = ledgerCursor(view, value.next);
      if (!rows.length || JSON.stringify(next) !== JSON.stringify(boundary)) {
        throw new TypeError('列表继续边界不匹配，请回到首页。');
      }
    } else if (value.next != null) {
      throw new TypeError('列表终点携带异常继续边界，请回到首页。');
    }
    return { rows, next };
  }

  function ledgerNavigation(request, next) {
    const footer = element('section');
    const actions = element('div', 'detail-actions');
    const load = (after) => {
      if (!footer.isConnected || !request.isCurrent()) return;
      return refresh({ pageCursor: after });
    };
    actions.append(actionButton('刷新当前页', () => load(request.after)));
    if (request.after)
      actions.append(actionButton('回到首页', () => load(null)));
    if (next) actions.append(actionButton('下一页', () => load(next)));
    footer.append(
      actions,
      element(
        'p',
        'privacy-note',
        '每次最多 64 条，翻页替换当前窗口。列表不是固定快照；顶部刷新或切换栏目从首页重新读取。',
      ),
    );
    return footer;
  }

  async function renderTasks(request) {
    const page = await readLedgerPage(request);
    if (!page) return;
    const tasks = page.rows;
    if (tasks.length === 0) {
      empty(
        request.after
          ? '当前窗口没有任务，可回到首页重新读取。'
          : '还没有可见任务。选择“创建任务”开始。',
      );
      nodes.ledger.append(ledgerNavigation(request, page.next));
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
    fragment.append(ledgerNavigation(request, page.next));
    replace(nodes.ledger, fragment);
  }

  async function selectTask(taskId) {
    state.selectedId = taskId;
    const selection = {};
    const project = state.project;
    const listRequest = state.listRequest;
    state.detailSelection = selection;
    const isCurrent = () =>
      state.detailSelection === selection &&
      state.listRequest === listRequest &&
      state.selectedId === taskId &&
      state.view === 'tasks' &&
      state.project === project &&
      Boolean(state.token);
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
      const value = await api(`/api/v3/projects/${project}/tasks/${taskId}`);
      if (!isCurrent()) return;
      if (value.task?.taskId !== taskId)
        throw new Error('Task identity mismatch');
      renderTaskDetail(value.task);
    } catch (error) {
      if (isCurrent()) detailEmpty(describeError(error));
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

  async function renderTriggers(request) {
    const page = await readLedgerPage(request);
    if (!page) return;
    const triggers = page.rows;
    if (triggers.length === 0) {
      empty(
        request.after
          ? '当前窗口没有定时，可回到首页重新读取。'
          : '还没有定时触发器。创建后，本地调度器会按 cron 自动生成 Run。',
      );
      nodes.ledger.append(ledgerNavigation(request, page.next));
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
    fragment.append(ledgerNavigation(request, page.next));
    replace(nodes.ledger, fragment);
  }

  async function selectTrigger(triggerId) {
    state.selectedId = triggerId;
    const selection = {};
    const project = state.project;
    const listRequest = state.listRequest;
    state.detailSelection = selection;
    const isCurrent = () =>
      state.detailSelection === selection &&
      state.listRequest === listRequest &&
      state.selectedId === triggerId &&
      state.view === 'triggers' &&
      state.project === project &&
      Boolean(state.token);
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
        `/api/v3/projects/${project}/triggers/${triggerId}`,
      );
      if (!isCurrent()) return;
      if (value.trigger?.triggerId !== triggerId)
        throw new Error('Trigger identity mismatch');
      renderTriggerDetail(value.trigger);
    } catch (error) {
      if (isCurrent()) detailEmpty(describeError(error));
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

  async function renderRuns(request) {
    const page = await readLedgerPage(request);
    if (!page) return;
    const runs = page.rows;
    if (runs.length === 0) {
      empty(
        request.after
          ? '当前窗口没有运行，可回到首页重新读取。'
          : '还没有运行记录。切换到任务，选择一个已启用 Task 开始运行。',
      );
      nodes.ledger.append(ledgerNavigation(request, page.next));
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
    fragment.append(ledgerNavigation(request, page.next));
    replace(nodes.ledger, fragment);
  }

  async function selectRun(runId) {
    state.selectedId = runId;
    const selection = { project: state.project };
    state.runSelection = selection;
    const isCurrent = () =>
      state.runSelection === selection &&
      state.selectedId === runId &&
      state.view === 'runs' &&
      state.project === selection.project &&
      Boolean(state.token);
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
      if (!isCurrent()) return;
      if (runValue.run?.id !== runId) throw new Error('Run identity mismatch');
      const loadPage = (offset) =>
        readRunLog(runValue.run, offset, selection.project);
      const logView = await loadPage(0);
      if (!isCurrent()) return;
      renderRunDetail(runValue.run, eventValue, stepValue, {
        ...logView,
        loadPage,
        isCurrent,
      });
    } catch (error) {
      if (isCurrent()) detailEmpty(describeError(error));
    }
  }

  async function readRunLog(run, offset = 0, project = state.project) {
    const attempt = run?.latestAttempt;
    if (!attempt || typeof attempt.id !== 'string') {
      return Object.freeze({ status: 'not_started' });
    }
    const context = { attempt, offset };
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return Object.freeze({ status: 'unavailable', ...context });
    }
    try {
      const value = await api(
        `/api/v3/projects/${project}/runs/${run.id}/attempts/${attempt.id}/log?offset=${offset}&length=${LOG_READ_BYTES}`,
      );
      if (
        value.schema !== 'qinglong/run-attempt-log-read-result@v1' ||
        value.projectId !== project ||
        value.runId !== run.id ||
        value.attemptId !== attempt.id
      )
        return Object.freeze({ status: 'unavailable', ...context });
      if (value.status === 'pending') {
        return Object.freeze({ status: 'pending', ...context });
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
        !Number.isSafeInteger(value.range.totalBytes) ||
        value.range.totalBytes < 0 ||
        value.range.start !== Math.min(offset, value.range.totalBytes) ||
        value.range.endExclusive < value.range.start ||
        value.range.endExclusive > value.range.totalBytes ||
        value.range.endExclusive - value.range.start > LOG_READ_BYTES ||
        window.atob(value.content).length !==
          value.range.endExclusive - value.range.start ||
        (value.range.endExclusive < value.range.totalBytes
          ? value.range.nextOffset !== value.range.endExclusive ||
            value.range.nextOffset <= offset
          : value.range.nextOffset !== undefined)
      ) {
        return Object.freeze({ status: 'unavailable', ...context });
      }
      return Object.freeze({
        status: 'available',
        ...context,
        content,
        range: value.range,
        truncation: value.truncation,
      });
    } catch (error) {
      if (error instanceof ConsoleRequestError && error.status === 410) {
        return Object.freeze({ status: 'retired', ...context });
      }
      if (error instanceof ConsoleRequestError && error.status === 404) {
        return Object.freeze({ status: 'not_found', ...context });
      }
      return Object.freeze({ status: 'unavailable', ...context });
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
    if (logView.attempt && logView.loadPage && logView.isCurrent) {
      const actions = element('div', 'detail-actions');
      let busy = false;
      const load = async (offset) => {
        if (busy || !section.isConnected || !logView.isCurrent()) return;
        busy = true;
        section.setAttribute('aria-busy', 'true');
        for (const button of actions.querySelectorAll('button'))
          button.disabled = true;
        try {
          const page = await logView.loadPage(offset);
          if (!section.isConnected || !logView.isCurrent()) return;
          section.replaceWith(
            renderRunLog({
              ...page,
              loadPage: logView.loadPage,
              isCurrent: logView.isCurrent,
            }),
          );
        } finally {
          busy = false;
          section.setAttribute('aria-busy', 'false');
          for (const button of actions.querySelectorAll('button'))
            button.disabled = false;
        }
      };
      actions.append(actionButton('刷新当前片段', () => load(logView.offset)));
      if (logView.offset > 0)
        actions.append(actionButton('回到开头', () => load(0)));
      if (
        logView.status === 'available' &&
        logView.range.nextOffset !== undefined
      ) {
        actions.append(
          actionButton('下一片段', () => load(logView.range.nextOffset)),
        );
      }
      section.append(actions);
    }
    if (logView.status === 'available') {
      const metadata = [
        `${logView.range.start}–${logView.range.endExclusive} / ${logView.range.totalBytes} bytes`,
      ];
      if (logView.truncation?.truncated === true) metadata.push('执行端已截断');
      if (logView.truncation?.truncated === 'unknown')
        metadata.push('截断状态未知');
      if (logView.range.nextOffset !== undefined)
        metadata.push('有后续片段；翻页替换当前窗口，不累计全文');
      metadata.push('按字节分片，跨片段的 UTF-8 字符可能显示替换符');
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
      nodes.createSecret.hidden = true;
      nodes.kicker.textContent = 'Project task authority';
      nodes.title.textContent = '任务调度台';
      nodes.description.textContent =
        '创建命令 Task，查看当前 revision 与内容围栏。管理写入需要部署设备上的一次性本机证明。';
    } else if (state.view === 'triggers') {
      nodes.createTask.hidden = true;
      nodes.createTrigger.hidden = false;
      nodes.createSecret.hidden = true;
      nodes.kicker.textContent = 'Durable cron authority';
      nodes.title.textContent = '定时触发器';
      nodes.description.textContent =
        '配置内置 cron Trigger，绑定 Task 当前 revision；停用只追加历史，不删除证据。';
    } else if (state.view === 'secrets') {
      nodes.createTask.hidden = true;
      nodes.createTrigger.hidden = true;
      nodes.createSecret.hidden = false;
      nodes.kicker.textContent = 'Encrypted local custody';
      nodes.title.textContent = 'Secret 凭据库';
      nodes.description.textContent =
        '只展示名称和当前版本；明文经本机证明后加密保存，Task 显式绑定固定版本。';
    } else {
      nodes.createTask.hidden = true;
      nodes.createTrigger.hidden = true;
      nodes.createSecret.hidden = true;
      nodes.kicker.textContent = 'Durable run evidence';
      nodes.title.textContent = '运行事实账本';
      nodes.description.textContent =
        '状态来自持久化 Run；取消只是请求，只有终态事件才能证明执行已经停止。';
    }
  }

  async function refresh(options = {}) {
    if (!state.token) return;
    state.selectedId = null;
    detailEmpty();
    const request = {
      project: state.project,
      view: state.view,
      after: options.pageCursor ?? null,
    };
    state.listRequest = request;
    request.isCurrent = () =>
      state.listRequest === request &&
      state.project === request.project &&
      state.view === request.view &&
      Boolean(state.token);
    loading();
    try {
      if (request.view === 'tasks') await renderTasks(request);
      else if (request.view === 'triggers') await renderTriggers(request);
      else if (request.view === 'secrets') await renderSecrets(request);
      else await renderRuns(request);
      if (request.isCurrent())
        setConnection('connected', `${request.project} · 已连接`);
    } catch (error) {
      if (request.isCurrent()) {
        errorState(error);
        if (request.after) nodes.ledger.append(ledgerNavigation(request, null));
      }
    } finally {
      if (request.isCurrent()) setBusy(false);
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
    state.secretSnapshot = null;
    state.secretCatalog = [];
    if (nodes.taskEditor.open) nodes.taskEditor.close();
    if (nodes.triggerEditor.open) nodes.triggerEditor.close();
    if (nodes.secretEditor.open) nodes.secretEditor.close();
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
    nodes.createSecret.hidden = true;
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
  nodes.createTask.addEventListener('click', async () => {
    try {
      await loadSecretCatalog();
      openTaskEditor();
    } catch (error) {
      showToast(describeError(error), 'error');
    }
  });
  nodes.createTrigger.addEventListener('click', () => openTriggerEditor());
  nodes.createSecret.addEventListener('click', () => openSecretEditor());
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
  nodes.secretEditorClose.addEventListener('click', () => {
    state.secretSnapshot = null;
    nodes.secretValue.value = '';
    nodes.secretEditor.close();
  });
  nodes.secretEditorForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveSecretDraft();
  });
  nodes.presenceCancel.addEventListener('click', () => {
    state.pendingPresence = null;
    state.authoringSnapshot = null;
    state.triggerSnapshot = null;
    state.secretSnapshot = null;
    nodes.secretValue.value = '';
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
      nodes.secretEditor.open ||
      nodes.presenceDialog.open
    ) {
      return;
    }
    const view =
      event.key.toLowerCase() === 't'
        ? 'tasks'
        : event.key.toLowerCase() === 's'
        ? 'triggers'
        : event.key.toLowerCase() === 'k'
        ? 'secrets'
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
