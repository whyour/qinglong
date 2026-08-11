import type { PostgresQueryable } from '@qinglong/runtime-core';

import {
  POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
} from '../identities';

import { defineSqlMigration } from '../shared';

const POSTGRES_USAGE_LEDGER_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger" (
  invocation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  trace_id varchar(128) NOT NULL,
  provider varchar(128) NOT NULL,
  model varchar(128) NOT NULL,
  policy_revision varchar(128) NOT NULL,
  completion_digest char(64) NOT NULL,
  outcome varchar(32) NOT NULL,
  settled_at_ms bigint NOT NULL,
  input_bytes integer NOT NULL,
  output_bytes integer NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  cost_micros bigint,
  ledger_digest char(64) NOT NULL,
  record_json jsonb NOT NULL,
  FOREIGN KEY (invocation_id, completion_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions"
      (invocation_id, completion_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_usage_identity_check CHECK (
    invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    trace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT ql3_model_invocation_usage_value_check CHECK (
    outcome IN ('succeeded', 'failed', 'timed_out', 'outcome_unknown') AND
    settled_at_ms >= 0 AND
    input_bytes BETWEEN 1 AND 262144 AND
    output_bytes BETWEEN 0 AND 1048576 AND
    input_tokens >= 0 AND output_tokens >= 0 AND
    total_tokens = input_tokens + output_tokens AND
    (cost_micros IS NULL OR cost_micros >= 0) AND
    completion_digest ~ '^[0-9a-f]{64}$' AND
    ledger_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_invocation_usage_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-usage-ledger@v1',
      'invocationId', invocation_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'traceId', trace_id,
      'provider', provider,
      'model', model,
      'policyRevision', policy_revision,
      'completionDigest', completion_digest,
      'outcome', outcome,
      'settledAtMs', settled_at_ms,
      'inputBytes', input_bytes,
      'outputBytes', output_bytes,
      'inputTokens', input_tokens,
      'outputTokens', output_tokens,
      'totalTokens', total_tokens,
      'costMicros', cost_micros,
      'ledgerDigest', ledger_digest
    )
  )
)`;

const postgresUsageMigration = defineSqlMigration<PostgresQueryable>(
  POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  [
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_identity_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions"
       (invocation_id, completion_digest)`,
    POSTGRES_USAGE_LEDGER_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_usage_project_time_idx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger"
       (project_id, settled_at_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_usage_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger"
       (ledger_digest)`,
    `REVOKE ALL ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger"
     FROM PUBLIC`,
    `GRANT SELECT, INSERT ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger"
     TO ql3_runtime`,
  ],
  (context, statement) => context.query(statement).then(() => undefined),
);

const POSTGRES_QUOTA_RESERVATION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations" (
  invocation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  model_policy_revision varchar(128) NOT NULL,
  quota_policy_revision varchar(128) NOT NULL,
  window_ms bigint NOT NULL,
  window_start_ms bigint NOT NULL,
  window_end_ms bigint NOT NULL,
  max_invocations integer NOT NULL,
  max_tokens bigint NOT NULL,
  max_cost_micros bigint,
  reserved_tokens bigint NOT NULL,
  reserved_cost_micros bigint,
  reserved_at_ms bigint NOT NULL,
  admission_digest char(64) NOT NULL,
  reservation_digest char(64) NOT NULL,
  record_json jsonb NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts"
      (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_quota_reservation_value_check CHECK (
    window_ms IN (60000, 3600000, 86400000) AND
    window_start_ms >= 0 AND window_end_ms = window_start_ms + window_ms AND
    reserved_at_ms >= window_start_ms AND reserved_at_ms < window_end_ms AND
    max_invocations BETWEEN 1 AND 100000 AND
    max_tokens BETWEEN 1 AND 1000000000000 AND
    (max_cost_micros IS NULL OR
      max_cost_micros BETWEEN 0 AND 1000000000000000) AND
    reserved_tokens BETWEEN 1 AND 1000000000000 AND
    (reserved_cost_micros IS NULL OR
      reserved_cost_micros BETWEEN 0 AND 1000000000000000) AND
    (max_cost_micros IS NULL OR reserved_cost_micros IS NOT NULL) AND
    admission_digest ~ '^[0-9a-f]{64}$' AND
    reservation_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_invocation_quota_reservation_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-quota-reservation@v1',
      'invocationId', invocation_id,
      'projectId', project_id,
      'modelPolicyRevision', model_policy_revision,
      'quotaPolicyRevision', quota_policy_revision,
      'windowMs', window_ms,
      'windowStartMs', window_start_ms,
      'windowEndMs', window_end_ms,
      'maxInvocations', max_invocations,
      'maxTokens', max_tokens,
      'maxCostMicros', max_cost_micros,
      'reservedTokens', reserved_tokens,
      'reservedCostMicros', reserved_cost_micros,
      'reservedAtMs', reserved_at_ms,
      'admissionDigest', admission_digest,
      'reservationDigest', reservation_digest
    )
  )
)`;

const POSTGRES_QUOTA_SETTLEMENT_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_settlements" (
  invocation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  reservation_digest char(64) NOT NULL,
  completion_digest char(64) NOT NULL,
  effective_tokens bigint NOT NULL,
  effective_cost_micros bigint,
  retained_token_reservation boolean NOT NULL,
  retained_cost_reservation boolean NOT NULL,
  settled_at_ms bigint NOT NULL,
  settlement_digest char(64) NOT NULL,
  record_json jsonb NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations"
      (invocation_id) ON DELETE RESTRICT,
  FOREIGN KEY (invocation_id, completion_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions"
      (invocation_id, completion_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_quota_settlement_value_check CHECK (
    effective_tokens BETWEEN 0 AND 1000000000000 AND
    (effective_cost_micros IS NULL OR
      effective_cost_micros BETWEEN 0 AND 1000000000000000) AND
    settled_at_ms >= 0 AND
    reservation_digest ~ '^[0-9a-f]{64}$' AND
    completion_digest ~ '^[0-9a-f]{64}$' AND
    settlement_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_invocation_quota_settlement_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-quota-settlement@v1',
      'invocationId', invocation_id,
      'projectId', project_id,
      'reservationDigest', reservation_digest,
      'completionDigest', completion_digest,
      'effectiveTokens', effective_tokens,
      'effectiveCostMicros', effective_cost_micros,
      'retainedTokenReservation', retained_token_reservation,
      'retainedCostReservation', retained_cost_reservation,
      'settledAtMs', settled_at_ms,
      'settlementDigest', settlement_digest
    )
  )
)`;

const postgresQuotaMigration = defineSqlMigration<PostgresQueryable>(
  POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  [
    POSTGRES_QUOTA_RESERVATION_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_quota_reservation_window_idx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations"
       (project_id, window_start_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_quota_reservation_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations"
       (reservation_digest)`,
    POSTGRES_QUOTA_SETTLEMENT_TABLE_SQL,
    `CREATE UNIQUE INDEX ql3_model_invocation_quota_settlement_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_settlements"
       (settlement_digest)`,
    `REVOKE ALL ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_settlements"
     FROM PUBLIC`,
    `GRANT SELECT, INSERT ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_settlements"
     TO ql3_runtime`,
  ],
  (context, statement) => context.query(statement).then(() => undefined),
);

const POSTGRES_PRICE_QUOTE_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes" (
  invocation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  model_policy_revision varchar(128) NOT NULL,
  provider varchar(128) NOT NULL,
  model varchar(128) NOT NULL,
  price_revision varchar(128) NOT NULL,
  currency varchar(3) NOT NULL,
  input_micros_per_million_tokens bigint NOT NULL,
  output_micros_per_million_tokens bigint NOT NULL,
  max_total_tokens bigint NOT NULL,
  max_output_tokens bigint NOT NULL,
  reserved_cost_micros bigint NOT NULL,
  catalog_digest char(64) NOT NULL,
  quote_digest char(64) NOT NULL,
  record_json jsonb NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts"
      (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_price_quote_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    model_policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    price_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT ql3_model_invocation_price_quote_value_check CHECK (
    currency = 'USD' AND
    input_micros_per_million_tokens BETWEEN 0 AND 1000000000000 AND
    output_micros_per_million_tokens BETWEEN 0 AND 1000000000000 AND
    max_total_tokens BETWEEN 1 AND 1000000000000 AND
    max_output_tokens BETWEEN 1 AND max_total_tokens AND
    reserved_cost_micros BETWEEN 0 AND 1000000000000000 AND
    catalog_digest ~ '^[0-9a-f]{64}$' AND
    quote_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_invocation_price_quote_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-price-quote@v1',
      'invocationId', invocation_id,
      'projectId', project_id,
      'modelPolicyRevision', model_policy_revision,
      'provider', provider,
      'model', model,
      'priceRevision', price_revision,
      'currency', currency,
      'inputMicrosPerMillionTokens', input_micros_per_million_tokens,
      'outputMicrosPerMillionTokens', output_micros_per_million_tokens,
      'maxTotalTokens', max_total_tokens,
      'maxOutputTokens', max_output_tokens,
      'reservedCostMicros', reserved_cost_micros,
      'catalogDigest', catalog_digest,
      'quoteDigest', quote_digest
    )
  )
)`;

const POSTGRES_PRICE_SETTLEMENT_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_settlements" (
  invocation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  quote_digest char(64) NOT NULL,
  completion_digest char(64) NOT NULL,
  currency varchar(3) NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cost_micros bigint NOT NULL,
  settled_at_ms bigint NOT NULL,
  settlement_digest char(64) NOT NULL,
  record_json jsonb NOT NULL,
  FOREIGN KEY (invocation_id, quote_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes"
      (invocation_id, quote_digest) ON DELETE RESTRICT,
  FOREIGN KEY (invocation_id, completion_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions"
      (invocation_id, completion_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_price_settlement_value_check CHECK (
    currency = 'USD' AND
    input_tokens >= 0 AND output_tokens >= 0 AND
    cost_micros BETWEEN 0 AND 1000000000000000 AND
    settled_at_ms >= 0 AND
    quote_digest ~ '^[0-9a-f]{64}$' AND
    completion_digest ~ '^[0-9a-f]{64}$' AND
    settlement_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_invocation_price_settlement_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-price-settlement@v1',
      'invocationId', invocation_id,
      'projectId', project_id,
      'quoteDigest', quote_digest,
      'completionDigest', completion_digest,
      'currency', currency,
      'inputTokens', input_tokens,
      'outputTokens', output_tokens,
      'costMicros', cost_micros,
      'settledAtMs', settled_at_ms,
      'settlementDigest', settlement_digest
    )
  )
)`;

const postgresPricingMigration = defineSqlMigration<PostgresQueryable>(
  POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  [
    POSTGRES_PRICE_QUOTE_TABLE_SQL,
    `CREATE UNIQUE INDEX ql3_model_invocation_price_quote_identity_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes"
       (invocation_id, quote_digest)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_price_quote_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes"
       (quote_digest)`,
    POSTGRES_PRICE_SETTLEMENT_TABLE_SQL,
    `CREATE UNIQUE INDEX ql3_model_invocation_price_settlement_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_settlements"
       (settlement_digest)`,
    `REVOKE ALL ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_settlements"
     FROM PUBLIC`,
    `GRANT SELECT, INSERT ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_settlements"
     TO ql3_runtime`,
  ],
  (context, statement) => context.query(statement).then(() => undefined),
);

export const postgresUsagePricingMigrations = Object.freeze([
  postgresUsageMigration,
  postgresQuotaMigration,
  postgresPricingMigration,
]);
