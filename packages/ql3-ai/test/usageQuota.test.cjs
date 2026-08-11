const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InvalidModelInvocationQuotaError,
  ModelInvocationQuotaConfigurationError,
  createModelInvocationQuotaAdmission,
  createModelInvocationQuotaReservation,
  createModelInvocationQuotaSettlement,
  normalizeModelInvocationProjectQuotaPolicy,
  normalizeModelInvocationQuotaAdmission,
  normalizeModelInvocationQuotaReservation,
} = require('../dist/usage/usageQuota.js');

const quota = Object.freeze({
  revision: 'quota-1',
  windowMs: 3_600_000,
  maxInvocations: 10,
  maxTokens: 10_000,
  maxCostMicros: 50_000,
});

function admission(overrides = {}) {
  return createModelInvocationQuotaAdmission({
    invocationId: 'invocation-a',
    projectId: 'project-a',
    modelPolicyRevision: 'model-policy-1',
    reservedTokens: 1_000,
    reservedCostMicros: 5_000,
    quota,
    ...overrides,
  });
}

function completion(overrides = {}) {
  return {
    invocationId: 'invocation-a',
    projectId: 'project-a',
    completionDigest: 'c'.repeat(64),
    completedAtMs: 3_600_200,
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      costMicros: 700,
    },
    ...overrides,
  };
}

test('quota admission reserves one bounded call in a database-aligned window', () => {
  const value = admission();
  const reservation = createModelInvocationQuotaReservation(value, 3_600_123);

  assert.deepEqual(normalizeModelInvocationProjectQuotaPolicy(quota), quota);
  assert.deepEqual(normalizeModelInvocationQuotaAdmission(value), value);
  assert.deepEqual(
    normalizeModelInvocationQuotaReservation(reservation),
    reservation,
  );
  assert.equal(reservation.windowStartMs, 3_600_000);
  assert.equal(reservation.windowEndMs, 7_200_000);
  assert.match(reservation.admissionDigest, /^[0-9a-f]{64}$/);
  assert.match(reservation.reservationDigest, /^[0-9a-f]{64}$/);
});

test('known usage settles actual consumption and releases unused capacity', () => {
  const reservation = createModelInvocationQuotaReservation(
    admission(),
    3_600_123,
  );
  const settlement = createModelInvocationQuotaSettlement(
    reservation,
    completion(),
  );

  assert.equal(settlement.effectiveTokens, 150);
  assert.equal(settlement.effectiveCostMicros, 700);
  assert.equal(settlement.retainedTokenReservation, false);
  assert.equal(settlement.retainedCostReservation, false);
});

test('unknown usage retains the full reservation', () => {
  const reservation = createModelInvocationQuotaReservation(
    admission(),
    3_600_123,
  );
  const settlement = createModelInvocationQuotaSettlement(
    reservation,
    completion({ usage: null }),
  );

  assert.equal(settlement.effectiveTokens, 1_000);
  assert.equal(settlement.effectiveCostMicros, 5_000);
  assert.equal(settlement.retainedTokenReservation, true);
  assert.equal(settlement.retainedCostReservation, true);
});

test('known tokens with unknown cost retain only the cost reservation', () => {
  const reservation = createModelInvocationQuotaReservation(
    admission(),
    3_600_123,
  );
  const settlement = createModelInvocationQuotaSettlement(
    reservation,
    completion({
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    }),
  );

  assert.equal(settlement.effectiveTokens, 150);
  assert.equal(settlement.effectiveCostMicros, 5_000);
  assert.equal(settlement.retainedTokenReservation, false);
  assert.equal(settlement.retainedCostReservation, true);
});

test('cost-disabled quota leaves billing cost to the usage ledger', () => {
  const reservation = createModelInvocationQuotaReservation(
    admission({
      reservedCostMicros: null,
      quota: { ...quota, maxCostMicros: null },
    }),
    3_600_123,
  );
  const settlement = createModelInvocationQuotaSettlement(
    reservation,
    completion(),
  );

  assert.equal(settlement.effectiveTokens, 150);
  assert.equal(settlement.effectiveCostMicros, null);
  assert.equal(settlement.retainedCostReservation, false);
});

test('cost quota without a per-call cost ceiling fails closed', () => {
  assert.throws(
    () => admission({ reservedCostMicros: null }),
    ModelInvocationQuotaConfigurationError,
  );
});

test('tampering and unsupported windows fail closed', () => {
  const value = admission();
  assert.throws(
    () =>
      normalizeModelInvocationQuotaAdmission({
        ...value,
        reservedTokens: value.reservedTokens + 1,
      }),
    InvalidModelInvocationQuotaError,
  );
  assert.throws(
    () => normalizeModelInvocationProjectQuotaPolicy({ ...quota, windowMs: 7 }),
    InvalidModelInvocationQuotaError,
  );
});
