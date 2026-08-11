const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  approvedActionExecutionEffectiveStatus,
  claimApprovedActionExecution,
  completeApprovedActionExecution,
  createApprovedActionExecution,
  releaseApprovedActionExecutionBeforeStart,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  ApprovedActionDispatcher,
} = require('@qinglong/runtime-core/approved-action-dispatcher');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const DISPATCHER = Object.freeze({ type: 'system', id: 'dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
const ACTION_DIGEST = 'a'.repeat(64);
const RESULT_DIGEST = 'c'.repeat(64);

function dispatch() {
  const pending = createApprovalRequest({
    id: 'approval-dispatcher-v1',
    projectId: 'default',
    action: {
      permission: 'package.manage',
      actionType: 'plugin_package.install',
      actionRef: 'proposal:dispatcher-v1',
      actionDigest: ACTION_DIGEST,
      previewDigest: 'b'.repeat(64),
    },
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 10,
    expiresAtMs: 10_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-dispatcher-v1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REQUESTER,
      authenticationId: 'auth-owner',
      authenticatedAtMs: 15,
      expiresAtMs: 5_000,
      assurance: 'local_console',
    },
    decidedAtMs: 20,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-dispatcher-v1',
    dispatchId: 'dispatch-dispatcher-v1',
    action: pending.action,
    requestedBy: REQUESTER,
    consumedBy: DISPATCHER,
    consumedAtMs: 30,
    authorizationFence: FENCE,
  }).dispatch;
}

class InMemoryExecutionRepository {
  constructor(value, options = {}) {
    this.dispatch = value;
    this.execution = createApprovedActionExecution(value);
    this.loseStartResponse = options.loseStartResponse === true;
    this.loseCompletionResponse = options.loseCompletionResponse === true;
    this.startCalls = 0;
    this.completeCalls = 0;
  }

  snapshot() {
    return Object.freeze({
      dispatch: this.dispatch,
      execution: this.execution,
    });
  }

  async findExecutionByDispatchId(dispatchId) {
    return dispatchId === this.dispatch.id ? this.snapshot() : null;
  }

  async listDueExecutions({ nowMs, limit, actionTypes }) {
    const effective = approvedActionExecutionEffectiveStatus(
      this.execution,
      nowMs,
    );
    const due =
      (effective === 'pending' || effective === 'retry_wait') &&
      this.execution.eligibleAtMs <= nowMs &&
      actionTypes.includes(this.dispatch.action.actionType);
    return {
      executions: due && limit > 0 ? [this.snapshot()] : [],
      truncated: false,
    };
  }

  async claimExecution(command) {
    if (command.dispatchId !== this.dispatch.id) return { status: 'not_found' };
    const effective = approvedActionExecutionEffectiveStatus(
      this.execution,
      command.nowMs,
    );
    if (effective !== 'pending' && effective !== 'retry_wait') {
      return { status: effective, snapshot: this.snapshot() };
    }
    this.execution = claimApprovedActionExecution(this.execution, {
      owner: command.owner,
      leaseToken: command.leaseToken,
      nowMs: command.nowMs,
      leaseDurationMs: command.leaseDurationMs,
    });
    return { status: 'claimed', snapshot: this.snapshot() };
  }

  async startExecution(command) {
    this.startCalls += 1;
    this.execution = startApprovedActionExecution(this.snapshot(), command);
    if (this.loseStartResponse) throw new Error('start response lost');
    return this.snapshot();
  }

  async renewExecution() {
    throw new Error('dispatcher must not renew after start');
  }

  async releaseExecutionBeforeStart(command) {
    this.execution = releaseApprovedActionExecutionBeforeStart(
      this.execution,
      {
        owner: command.owner,
        leaseToken: command.leaseToken,
        expectedVersion: command.expectedVersion,
        resultMutationId: command.resultMutationId,
        resultCode: command.resultCode,
        atMs: command.atMs,
        ...(command.retryAtMs === undefined
          ? {}
          : { retryAtMs: command.retryAtMs }),
      },
    );
    return this.snapshot();
  }

  async completeExecution(command) {
    this.completeCalls += 1;
    this.execution = completeApprovedActionExecution(this.execution, {
      owner: command.owner,
      leaseToken: command.leaseToken,
      expectedVersion: command.expectedVersion,
      resultMutationId: command.resultMutationId,
      outcome: command.outcome,
      resultCode: command.resultCode,
      ...(command.resultDigest === undefined
        ? {}
        : { resultDigest: command.resultDigest }),
      completedAtMs: command.completedAtMs,
    });
    if (this.loseCompletionResponse) {
      throw new Error('completion response lost');
    }
    return this.snapshot();
  }
}

function createDispatcher(repository, handler) {
  let id = 0;
  return new ApprovedActionDispatcher(repository, [handler], {
    owner: 'dispatcher_instance_1',
    leaseDurationMs: 1_000,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    defaultBatchSize: 1,
    clock: () => 100,
    createId: () => `dispatcher-id-${++id}`,
  });
}

test('commits the start barrier before executing and completes one success', async () => {
  const repository = new InMemoryExecutionRepository(dispatch());
  let observed;
  const dispatcher = createDispatcher(repository, {
    actionType: 'plugin_package.install',
    async inspect(value) {
      return { status: 'ready', actionDigest: value.action.actionDigest };
    },
    async execute(context) {
      observed = context;
      return {
        outcome: 'succeeded',
        resultCode: 'package_admitted',
        resultDigest: RESULT_DIGEST,
      };
    },
  });
  const summary = await dispatcher.dispatchBatch();
  assert.deepEqual(summary, {
    scanned: 1,
    claimed: 1,
    started: 1,
    succeeded: 1,
    failed: 0,
    blocked: 0,
    retrying: 0,
    deferred: 0,
    recoveryRequired: 0,
    alreadyTerminal: 0,
    unavailable: 0,
    truncated: false,
  });
  assert.equal(observed.execution.status, 'executing');
  assert.equal(observed.execution.version, observed.fence.version);
  assert.equal(repository.execution.status, 'succeeded');
  assert.equal(repository.execution.resultDigest, RESULT_DIGEST);
});

test('retries inspection only before start and blocks an exception after start', async () => {
  const retryRepository = new InMemoryExecutionRepository(dispatch());
  const retrying = await createDispatcher(retryRepository, {
    actionType: 'plugin_package.install',
    async inspect() {
      return { status: 'retry', resultCode: 'proposal_unavailable' };
    },
    async execute() {
      throw new Error('must not execute');
    },
  }).dispatchBatch();
  assert.equal(retrying.retrying, 1);
  assert.equal(retrying.started, 0);
  assert.equal(retryRepository.execution.status, 'retry_wait');

  const blockedRepository = new InMemoryExecutionRepository(dispatch());
  const blocked = await createDispatcher(blockedRepository, {
    actionType: 'plugin_package.install',
    async inspect() {
      return { status: 'ready', actionDigest: ACTION_DIGEST };
    },
    async execute() {
      throw new Error('outcome is indeterminate');
    },
  }).dispatchBatch();
  assert.equal(blocked.started, 1);
  assert.equal(blocked.blocked, 1);
  assert.equal(blocked.retrying, 0);
  assert.equal(blockedRepository.execution.status, 'blocked');
  assert.equal(
    blockedRepository.execution.resultCode,
    'handler_failed_after_start',
  );
});

test('converges lost start and completion responses without repeating effects', async () => {
  const repository = new InMemoryExecutionRepository(dispatch(), {
    loseStartResponse: true,
    loseCompletionResponse: true,
  });
  let effects = 0;
  const summary = await createDispatcher(repository, {
    actionType: 'plugin_package.install',
    async inspect() {
      return { status: 'ready', actionDigest: ACTION_DIGEST };
    },
    async execute() {
      effects += 1;
      return {
        outcome: 'succeeded',
        resultCode: 'package_admitted',
        resultDigest: RESULT_DIGEST,
      };
    },
  }).dispatchBatch();
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.unavailable, 0);
  assert.equal(repository.startCalls, 1);
  assert.equal(repository.completeCalls, 1);
  assert.equal(effects, 1);
});

test('does not claim an action without a matching handler', async () => {
  const repository = new InMemoryExecutionRepository(dispatch());
  let id = 0;
  const dispatcher = new ApprovedActionDispatcher(repository, [], {
    owner: 'dispatcher_instance_1',
    clock: () => 100,
    createId: () => `dispatcher-id-${++id}`,
  });
  const summary = await dispatcher.dispatchBatch({ limit: 1 });
  assert.equal(summary.scanned, 0);
  assert.equal(summary.claimed, 0);
  assert.equal(summary.blocked, 0);
  assert.equal(summary.started, 0);
  assert.equal(repository.execution.status, 'pending');
  assert.equal(repository.startCalls, 0);
});
