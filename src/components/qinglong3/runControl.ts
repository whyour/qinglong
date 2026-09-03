import {
  qingLong3Credential,
  qingLong3Session,
  type QingLong3Capabilities,
} from '@/utils/qinglong3';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const STATUSES = new Set([
  ...TERMINAL,
  'created',
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'retry_wait',
  'lost',
]);

export interface PanelTask {
  taskId: string;
  name: string;
  revision: number;
  contentDigest: string;
  enabled: boolean;
}
export interface PanelRun {
  id: string;
  taskId: string;
  taskRevision: string;
  status: string;
  createdAtMs: number;
  latestAttempt?: { id: string; logAvailable: boolean } | null;
}
export interface RunCursor {
  createdAtMs: number;
  runId: string;
}
export interface RunPage {
  runs: PanelRun[];
  next?: RunCursor;
  scanned: number;
}
export interface PreparedRunAction {
  kind: 'start' | 'cancel';
  target: string;
  mutationId: string;
  execute(): Promise<{ runId: string; status: string }>;
}

export class PanelRunControlError extends Error {
  constructor(readonly code: string, readonly uncertain = false) {
    super(code);
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function cursorOf(value: any): RunCursor {
  if (
    !value ||
    !validTime(value.createdAtMs) ||
    !validId(value.runId) ||
    Object.keys(value).sort().join(',') !== 'createdAtMs,runId'
  ) {
    throw new PanelRunControlError('invalid_run_page');
  }
  return Object.freeze({ createdAtMs: value.createdAtMs, runId: value.runId });
}
function follows(left: RunCursor, right: RunCursor): boolean {
  return (
    right.createdAtMs < left.createdAtMs ||
    (right.createdAtMs === left.createdAtMs && right.runId < left.runId)
  );
}
function runOf(value: any): PanelRun {
  if (
    !value ||
    !validId(value.id) ||
    !validId(value.taskId) ||
    typeof value.taskRevision !== 'string' ||
    value.taskRevision.length > 255 ||
    !value.taskRevision ||
    !STATUSES.has(value.status) ||
    !validTime(value.createdAtMs)
  ) {
    throw new PanelRunControlError('invalid_run_response');
  }
  if (
    value.latestAttempt != null &&
    (!validId(value.latestAttempt.id) ||
      typeof value.latestAttempt.logAvailable !== 'boolean')
  ) {
    throw new PanelRunControlError('invalid_run_response');
  }
  return Object.freeze({
    id: value.id,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    status: value.status,
    createdAtMs: value.createdAtMs,
    ...(value.latestAttempt === undefined
      ? {}
      : {
          latestAttempt:
            value.latestAttempt === null
              ? null
              : Object.freeze({
                  id: value.latestAttempt.id,
                  logAvailable: value.latestAttempt.logAvailable,
                }),
        }),
  });
}

export function createPanelRunControl(
  cron: any,
  capabilities: Readonly<QingLong3Capabilities>,
) {
  const projectId = cron?.ql3?.projectId,
    taskId = cron?.ql3?.taskId;
  if (
    !validId(projectId) ||
    !validId(taskId) ||
    capabilities.panel.runControl !== 'task_run_v1'
  ) {
    throw new PanelRunControlError('run_control_unavailable');
  }
  const session = qingLong3Session();
  let disposed = false,
    writing = false;
  let currentTask: PanelTask | null = null,
    currentRun: PanelRun | null = null;
  const base = `/api/v3/projects/${projectId}`;
  const isCurrent = () =>
    !disposed &&
    session === qingLong3Session() &&
    Boolean(qingLong3Credential());
  const assertCurrent = () => {
    if (!isCurrent()) throw new PanelRunControlError('session_changed');
  };
  const request = async (
    path: string,
    body?: object,
    accepted: number[] = [],
  ) => {
    assertCurrent();
    let response: Response, value: any;
    try {
      response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${qingLong3Credential()}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      value = await response.json();
    } catch {
      assertCurrent();
      throw new PanelRunControlError('request_unavailable', Boolean(body));
    }
    assertCurrent();
    if (!response.ok && !accepted.includes(response.status)) {
      throw new PanelRunControlError(
        typeof value?.code === 'string' ? value.code : 'request_unavailable',
        Boolean(body) && response.status >= 500,
      );
    }
    return { value, status: response.status };
  };
  const prepared = (
    kind: 'start' | 'cancel',
    target: string,
    fields: object,
    validate: (value: any) => boolean,
  ): PreparedRunAction => {
    const mutationId = crypto.randomUUID();
    const body = Object.freeze({ ...fields, mutationId });
    const path =
      kind === 'start'
        ? `${base}/tasks/${taskId}/runs`
        : `${base}/runs/${target}/cancellation`;
    return Object.freeze({
      kind,
      target,
      mutationId,
      async execute() {
        assertCurrent();
        if (writing) throw new PanelRunControlError('operation_pending');
        writing = true;
        try {
          const { value } = await request(path, body);
          if (!validate(value))
            throw new PanelRunControlError('invalid_mutation_response', true);
          return Object.freeze({
            runId: value.runId as string,
            status: value.status as string,
          });
        } finally {
          writing = false;
        }
      },
    });
  };
  return Object.freeze({
    isCurrent,
    dispose() {
      disposed = true;
      currentTask = null;
      currentRun = null;
    },
    async readTask(): Promise<PanelTask> {
      const { value } = await request(`${base}/tasks/${taskId}`);
      const task = value?.task;
      if (
        !task ||
        task.taskId !== taskId ||
        typeof task.name !== 'string' ||
        task.name.length > 512 ||
        !Number.isSafeInteger(task.revision) ||
        task.revision < 1 ||
        !DIGEST.test(task.contentDigest) ||
        typeof task.enabled !== 'boolean'
      ) {
        throw new PanelRunControlError('invalid_task_response');
      }
      currentTask = Object.freeze({
        taskId,
        name: task.name,
        revision: task.revision,
        contentDigest: task.contentDigest,
        enabled: task.enabled,
      });
      return currentTask;
    },
    async listRuns(after?: RunCursor): Promise<RunPage> {
      const cursor = after ? cursorOf(after) : undefined;
      // Canonical IDs contain no query separators; the HTTP parser rejects encoded colon aliases.
      const query = cursor
        ? `&after_created_at_ms=${cursor.createdAtMs}&after_run_id=${cursor.runId}`
        : '';
      const { value } = await request(`${base}/runs?limit=64${query}`);
      if (
        !Array.isArray(value?.runs) ||
        value.runs.length > 64 ||
        typeof value.hasMore !== 'boolean' ||
        value.hasMore !== Boolean(value.next)
      )
        throw new PanelRunControlError('invalid_run_page');
      const runs: PanelRun[] = value.runs.map(runOf);
      let previous = cursor;
      for (const run of runs) {
        const next = { createdAtMs: run.createdAtMs, runId: run.id };
        if (previous && !follows(previous, next))
          throw new PanelRunControlError('invalid_run_page');
        previous = next;
      }
      const next = value.next ? cursorOf(value.next) : undefined;
      if (
        next &&
        (!runs.length ||
          next.runId !== previous?.runId ||
          next.createdAtMs !== previous?.createdAtMs)
      ) {
        throw new PanelRunControlError('invalid_run_page');
      }
      return {
        runs: runs.filter((run) => run.taskId === taskId),
        scanned: runs.length,
        next,
      };
    },
    async readRun(runId: string): Promise<PanelRun> {
      if (!validId(runId))
        throw new PanelRunControlError('invalid_run_identity');
      const { value } = await request(`${base}/runs/${runId}`);
      const run = runOf(value?.run);
      if (
        run.id !== runId ||
        run.taskId !== taskId ||
        value.run.projectId !== projectId
      ) {
        throw new PanelRunControlError('invalid_run_identity');
      }
      currentRun = run;
      return run;
    },
    prepareStart(task: PanelTask) {
      assertCurrent();
      if (task !== currentTask || !task.enabled)
        throw new PanelRunControlError('task_not_ready');
      return prepared(
        'start',
        taskId,
        {
          schema: 'qinglong/task-start@v1',
          expectedRevision: task.revision,
          expectedContentDigest: task.contentDigest,
        },
        (value) =>
          value?.schema === 'qinglong/task-start@v1' &&
          value.projectId === projectId &&
          value.taskId === taskId &&
          value.taskRevision === task.revision &&
          value.taskContentDigest === task.contentDigest &&
          validId(value.runId) &&
          ['accepted', 'existing'].includes(value.status),
      );
    },
    prepareCancel(run: PanelRun) {
      assertCurrent();
      if (run !== currentRun || TERMINAL.has(run.status))
        throw new PanelRunControlError('run_not_active');
      return prepared(
        'cancel',
        run.id,
        { schema: 'qinglong/run-cancellation@v1' },
        (value) =>
          value?.schema === 'qinglong/run-cancellation@v1' &&
          value.projectId === projectId &&
          value.runId === run.id &&
          ['accepted', 'already_requested', 'already_terminal'].includes(
            value.status,
          ),
      );
    },
    async readLog(run: PanelRun): Promise<string> {
      if (run !== currentRun)
        throw new PanelRunControlError('invalid_run_identity');
      if (!run.latestAttempt?.logAvailable)
        return '当前运行尚无可读日志，请刷新运行状态后重试。';
      const length = capabilities.limits.logChunkBytes;
      const attemptId = run.latestAttempt.id;
      const { value, status } = await request(
        `${base}/runs/${run.id}/attempts/${attemptId}/log?offset=0&length=${length}`,
        undefined,
        [202, 410],
      );
      if (status === 202) return '日志尚未就绪。';
      if (status === 410) return '日志已按保留策略清理。';
      if (
        value?.status !== 'available' ||
        value.encoding !== 'base64' ||
        value.runId !== run.id ||
        value.attemptId !== attemptId ||
        typeof value.content !== 'string' ||
        value.content.length > Math.ceil(length / 3) * 4
      ) {
        throw new PanelRunControlError('invalid_log_response');
      }
      const bytes = Uint8Array.from(atob(value.content), (c) =>
        c.charCodeAt(0),
      );
      if (bytes.length > length)
        throw new PanelRunControlError('invalid_log_response');
      return `${new TextDecoder().decode(
        bytes,
      )}\n\n[本次仅显示首个至多 ${length} 字节；刷新不自动续读]`;
    },
  });
}
