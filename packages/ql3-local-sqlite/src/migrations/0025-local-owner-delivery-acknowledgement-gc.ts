import { defineLocalSqliteMigration } from './sqlMigration';

export const local0025LocalOwnerDeliveryAcknowledgementGcMigration =
  defineLocalSqliteMigration({
    id: '0025-local-owner-delivery-acknowledgement-gc',
    statements: [
      `
CREATE TABLE "QingLong3LocalOwnerDeliveryAcknowledgementGc" (
  "gc_mutation_id" TEXT PRIMARY KEY NOT NULL,
  "gc_request_id" TEXT NOT NULL,
  "acknowledgement_mutation_id" TEXT NOT NULL,
  "acknowledgement_kind" TEXT NOT NULL,
  "delivery_digest" TEXT NOT NULL,
  "acknowledged_at_ms" INTEGER NOT NULL,
  "acknowledgement_semantic_digest" TEXT NOT NULL,
  "bridge_clear_evidence_digest" TEXT NOT NULL,
  "retention_policy_version" INTEGER NOT NULL,
  "replay_retention_ms" INTEGER NOT NULL,
  "audit_retention_ms" INTEGER NOT NULL,
  "retention_policy_digest" TEXT NOT NULL,
  "retention_eligible_at_ms" INTEGER NOT NULL,
  "compacted_at_ms" INTEGER NOT NULL,
  "audit_event_id" TEXT NOT NULL,
  "provisioning_mutation_id" TEXT,
  "challenge_mutation_id" TEXT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("provisioning_mutation_id")
    REFERENCES "QingLong3LocalIdentityProvisionings" ("mutation_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("challenge_mutation_id")
    REFERENCES "QingLong3LocalOwnerBootstrapChallenges" ("issue_mutation_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_owner_delivery_ack_gc_mutation_check CHECK (
    length("gc_mutation_id") = 36
    AND "audit_event_id" = "gc_mutation_id"
    AND length("acknowledgement_mutation_id") = 36
    AND "acknowledgement_mutation_id" <> "gc_mutation_id"
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_gc_request_check CHECK (
    length("gc_request_id") BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_gc_digest_check CHECK (
    length("delivery_digest") = 64
    AND "delivery_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("acknowledgement_semantic_digest") = 64
    AND "acknowledgement_semantic_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("bridge_clear_evidence_digest") = 64
    AND "bridge_clear_evidence_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("retention_policy_digest") = 64
    AND "retention_policy_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_gc_retention_check CHECK (
    "retention_policy_version" = 1
    AND "replay_retention_ms" BETWEEN 2592000000 AND 315360000000
    AND "audit_retention_ms" BETWEEN 2592000000 AND 315360000000
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_gc_time_check CHECK (
    "acknowledged_at_ms" >= 0
    AND "retention_eligible_at_ms" <= "compacted_at_ms"
    AND "compacted_at_ms" >= "acknowledged_at_ms"
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_gc_shape_check CHECK (
    (
      "acknowledgement_kind" = 'credential'
      AND "provisioning_mutation_id" = "acknowledgement_mutation_id"
      AND "challenge_mutation_id" IS NULL
    )
    OR (
      "acknowledgement_kind" = 'challenge'
      AND "provisioning_mutation_id" IS NULL
      AND "challenge_mutation_id" = "acknowledgement_mutation_id"
    )
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_delivery_ack_gc_ack_uidx"
ON "QingLong3LocalOwnerDeliveryAcknowledgementGc" (
  "acknowledgement_mutation_id"
)
      `,
      `
CREATE INDEX "ql3_local_owner_delivery_ack_gc_compacted_idx"
ON "QingLong3LocalOwnerDeliveryAcknowledgementGc" (
  "acknowledgement_kind", "compacted_at_ms", "acknowledgement_mutation_id"
)
      `,
    ],
  });
