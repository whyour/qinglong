import type { LocalMigrationContext } from './context';

import {
  LOCAL_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_PRICING_MIGRATION_ID,
} from '../identities';

import { defineSqlMigration } from '../shared';

const LOCAL_USAGE_LEDGER_TABLE_SQL = `
CREATE TABLE "ModelInvocationUsageLedger" (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  completion_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  settled_at_ms INTEGER NOT NULL,
  input_bytes INTEGER NOT NULL,
  output_bytes INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_micros INTEGER,
  ledger_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (invocation_id, completion_digest)
    REFERENCES "ModelInvocationCompletions"
      (invocation_id, completion_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_usage_identity_check CHECK (
    length(invocation_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(trace_id) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 128 AND
    length(model) BETWEEN 1 AND 128 AND
    length(policy_revision) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_model_invocation_usage_value_check CHECK (
    outcome IN ('succeeded', 'failed', 'timed_out', 'outcome_unknown') AND
    settled_at_ms >= 0 AND
    input_bytes BETWEEN 1 AND 262144 AND
    output_bytes BETWEEN 0 AND 1048576 AND
    input_tokens >= 0 AND output_tokens >= 0 AND
    total_tokens = input_tokens + output_tokens AND
    (cost_micros IS NULL OR cost_micros >= 0) AND
    length(completion_digest) = 64 AND
      completion_digest NOT GLOB '*[^0-9a-f]*' AND
    length(ledger_digest) = 64 AND
      ledger_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_usage_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-usage-ledger@v1' AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.runId') = run_id AND
    json_extract(record_json, '$.stepRunId') = step_run_id AND
    json_extract(record_json, '$.traceId') = trace_id AND
    json_extract(record_json, '$.provider') = provider AND
    json_extract(record_json, '$.model') = model AND
    json_extract(record_json, '$.policyRevision') = policy_revision AND
    json_extract(record_json, '$.completionDigest') = completion_digest AND
    json_extract(record_json, '$.outcome') = outcome AND
    json_extract(record_json, '$.settledAtMs') = settled_at_ms AND
    json_extract(record_json, '$.inputBytes') = input_bytes AND
    json_extract(record_json, '$.outputBytes') = output_bytes AND
    json_extract(record_json, '$.inputTokens') = input_tokens AND
    json_extract(record_json, '$.outputTokens') = output_tokens AND
    json_extract(record_json, '$.totalTokens') = total_tokens AND
    ((cost_micros IS NULL AND
      json_type(record_json, '$.costMicros') = 'null') OR
     json_extract(record_json, '$.costMicros') = cost_micros) AND
    json_extract(record_json, '$.ledgerDigest') = ledger_digest
  )
)`;

const localUsageMigration = defineSqlMigration<LocalMigrationContext>(
  LOCAL_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  [
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_identity_digest_uidx
       ON "ModelInvocationCompletions" (invocation_id, completion_digest)`,
    LOCAL_USAGE_LEDGER_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_usage_project_time_idx
       ON "ModelInvocationUsageLedger"
       (project_id, settled_at_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_usage_digest_uidx
       ON "ModelInvocationUsageLedger" (ledger_digest)`,
  ],
  (context, statement) => context.client.exec(statement),
);

const LOCAL_QUOTA_RESERVATION_TABLE_SQL = `
CREATE TABLE "ModelInvocationQuotaReservations" (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  model_policy_revision TEXT NOT NULL,
  quota_policy_revision TEXT NOT NULL,
  window_ms INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL,
  max_invocations INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  max_cost_micros INTEGER,
  reserved_tokens INTEGER NOT NULL,
  reserved_cost_micros INTEGER,
  reserved_at_ms INTEGER NOT NULL,
  admission_digest TEXT NOT NULL,
  reservation_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationStarts" (invocation_id) ON DELETE RESTRICT,
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
    length(admission_digest) = 64 AND
      admission_digest NOT GLOB '*[^0-9a-f]*' AND
    length(reservation_digest) = 64 AND
      reservation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_quota_reservation_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-quota-reservation@v1' AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.modelPolicyRevision') =
      model_policy_revision AND
    json_extract(record_json, '$.quotaPolicyRevision') =
      quota_policy_revision AND
    json_extract(record_json, '$.windowMs') = window_ms AND
    json_extract(record_json, '$.windowStartMs') = window_start_ms AND
    json_extract(record_json, '$.windowEndMs') = window_end_ms AND
    json_extract(record_json, '$.maxInvocations') = max_invocations AND
    json_extract(record_json, '$.maxTokens') = max_tokens AND
    ((max_cost_micros IS NULL AND
      json_type(record_json, '$.maxCostMicros') = 'null') OR
     json_extract(record_json, '$.maxCostMicros') = max_cost_micros) AND
    json_extract(record_json, '$.reservedTokens') = reserved_tokens AND
    ((reserved_cost_micros IS NULL AND
      json_type(record_json, '$.reservedCostMicros') = 'null') OR
     json_extract(record_json, '$.reservedCostMicros') =
       reserved_cost_micros) AND
    json_extract(record_json, '$.reservedAtMs') = reserved_at_ms AND
    json_extract(record_json, '$.admissionDigest') = admission_digest AND
    json_extract(record_json, '$.reservationDigest') = reservation_digest
  )
)`;

const LOCAL_QUOTA_SETTLEMENT_TABLE_SQL = `
CREATE TABLE "ModelInvocationQuotaSettlements" (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  reservation_digest TEXT NOT NULL,
  completion_digest TEXT NOT NULL,
  effective_tokens INTEGER NOT NULL,
  effective_cost_micros INTEGER,
  retained_token_reservation INTEGER NOT NULL,
  retained_cost_reservation INTEGER NOT NULL,
  settled_at_ms INTEGER NOT NULL,
  settlement_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationQuotaReservations" (invocation_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (invocation_id, completion_digest)
    REFERENCES "ModelInvocationCompletions"
      (invocation_id, completion_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_quota_settlement_value_check CHECK (
    effective_tokens BETWEEN 0 AND 1000000000000 AND
    (effective_cost_micros IS NULL OR
      effective_cost_micros BETWEEN 0 AND 1000000000000000) AND
    retained_token_reservation IN (0, 1) AND
    retained_cost_reservation IN (0, 1) AND
    settled_at_ms >= 0 AND
    length(reservation_digest) = 64 AND
      reservation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(completion_digest) = 64 AND
      completion_digest NOT GLOB '*[^0-9a-f]*' AND
    length(settlement_digest) = 64 AND
      settlement_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_quota_settlement_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-quota-settlement@v1' AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.reservationDigest') =
      reservation_digest AND
    json_extract(record_json, '$.completionDigest') = completion_digest AND
    json_extract(record_json, '$.effectiveTokens') = effective_tokens AND
    ((effective_cost_micros IS NULL AND
      json_type(record_json, '$.effectiveCostMicros') = 'null') OR
     json_extract(record_json, '$.effectiveCostMicros') =
       effective_cost_micros) AND
    json_extract(record_json, '$.retainedTokenReservation') =
      retained_token_reservation AND
    json_extract(record_json, '$.retainedCostReservation') =
      retained_cost_reservation AND
    json_extract(record_json, '$.settledAtMs') = settled_at_ms AND
    json_extract(record_json, '$.settlementDigest') = settlement_digest
  )
)`;

const localQuotaMigration = defineSqlMigration<LocalMigrationContext>(
  LOCAL_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  [
    LOCAL_QUOTA_RESERVATION_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_quota_reservation_window_idx
       ON "ModelInvocationQuotaReservations"
       (project_id, window_start_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_quota_reservation_digest_uidx
       ON "ModelInvocationQuotaReservations" (reservation_digest)`,
    LOCAL_QUOTA_SETTLEMENT_TABLE_SQL,
    `CREATE UNIQUE INDEX ql3_model_invocation_quota_settlement_digest_uidx
       ON "ModelInvocationQuotaSettlements" (settlement_digest)`,
  ],
  (context, statement) => context.client.exec(statement),
);

const LOCAL_PRICE_QUOTE_TABLE_SQL = `
CREATE TABLE "ModelInvocationPriceQuotes" (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  model_policy_revision TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  price_revision TEXT NOT NULL,
  currency TEXT NOT NULL,
  input_micros_per_million_tokens INTEGER NOT NULL,
  output_micros_per_million_tokens INTEGER NOT NULL,
  max_total_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  reserved_cost_micros INTEGER NOT NULL,
  catalog_digest TEXT NOT NULL,
  quote_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationStarts" (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_price_quote_identity_check CHECK (
    length(project_id) BETWEEN 1 AND 128 AND
    length(model_policy_revision) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 128 AND
    length(model) BETWEEN 1 AND 128 AND
    length(price_revision) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_model_invocation_price_quote_value_check CHECK (
    currency = 'USD' AND
    input_micros_per_million_tokens BETWEEN 0 AND 1000000000000 AND
    output_micros_per_million_tokens BETWEEN 0 AND 1000000000000 AND
    max_total_tokens BETWEEN 1 AND 1000000000000 AND
    max_output_tokens BETWEEN 1 AND max_total_tokens AND
    reserved_cost_micros BETWEEN 0 AND 1000000000000000 AND
    length(catalog_digest) = 64 AND
      catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(quote_digest) = 64 AND
      quote_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_price_quote_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-price-quote@v1' AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.modelPolicyRevision') =
      model_policy_revision AND
    json_extract(record_json, '$.provider') = provider AND
    json_extract(record_json, '$.model') = model AND
    json_extract(record_json, '$.priceRevision') = price_revision AND
    json_extract(record_json, '$.currency') = currency AND
    json_extract(record_json, '$.inputMicrosPerMillionTokens') =
      input_micros_per_million_tokens AND
    json_extract(record_json, '$.outputMicrosPerMillionTokens') =
      output_micros_per_million_tokens AND
    json_extract(record_json, '$.maxTotalTokens') = max_total_tokens AND
    json_extract(record_json, '$.maxOutputTokens') = max_output_tokens AND
    json_extract(record_json, '$.reservedCostMicros') =
      reserved_cost_micros AND
    json_extract(record_json, '$.catalogDigest') = catalog_digest AND
    json_extract(record_json, '$.quoteDigest') = quote_digest
  )
)`;

const LOCAL_PRICE_SETTLEMENT_TABLE_SQL = `
CREATE TABLE "ModelInvocationPriceSettlements" (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  quote_digest TEXT NOT NULL,
  completion_digest TEXT NOT NULL,
  currency TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  settled_at_ms INTEGER NOT NULL,
  settlement_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (invocation_id, quote_digest)
    REFERENCES "ModelInvocationPriceQuotes"
      (invocation_id, quote_digest) ON DELETE RESTRICT,
  FOREIGN KEY (invocation_id, completion_digest)
    REFERENCES "ModelInvocationCompletions"
      (invocation_id, completion_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_price_settlement_value_check CHECK (
    currency = 'USD' AND
    input_tokens >= 0 AND output_tokens >= 0 AND
    cost_micros BETWEEN 0 AND 1000000000000000 AND
    settled_at_ms >= 0 AND
    length(quote_digest) = 64 AND
      quote_digest NOT GLOB '*[^0-9a-f]*' AND
    length(completion_digest) = 64 AND
      completion_digest NOT GLOB '*[^0-9a-f]*' AND
    length(settlement_digest) = 64 AND
      settlement_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_price_settlement_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-price-settlement@v1' AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.quoteDigest') = quote_digest AND
    json_extract(record_json, '$.completionDigest') =
      completion_digest AND
    json_extract(record_json, '$.currency') = currency AND
    json_extract(record_json, '$.inputTokens') = input_tokens AND
    json_extract(record_json, '$.outputTokens') = output_tokens AND
    json_extract(record_json, '$.costMicros') = cost_micros AND
    json_extract(record_json, '$.settledAtMs') = settled_at_ms AND
    json_extract(record_json, '$.settlementDigest') = settlement_digest
  )
)`;

const localPricingMigration = defineSqlMigration<LocalMigrationContext>(
  LOCAL_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  [
    LOCAL_PRICE_QUOTE_TABLE_SQL,
    `CREATE UNIQUE INDEX ql3_model_invocation_price_quote_identity_digest_uidx
       ON "ModelInvocationPriceQuotes" (invocation_id, quote_digest)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_price_quote_digest_uidx
       ON "ModelInvocationPriceQuotes" (quote_digest)`,
    LOCAL_PRICE_SETTLEMENT_TABLE_SQL,
    `CREATE UNIQUE INDEX ql3_model_invocation_price_settlement_digest_uidx
       ON "ModelInvocationPriceSettlements" (settlement_digest)`,
  ],
  (context, statement) => context.client.exec(statement),
);

export const sqliteUsagePricingMigrations = Object.freeze([
  localUsageMigration,
  localQuotaMigration,
  localPricingMigration,
]);
