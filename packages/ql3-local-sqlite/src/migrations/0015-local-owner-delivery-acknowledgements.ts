import { defineLocalSqliteMigration } from './sqlMigration';

export const local0015LocalOwnerDeliveryAcknowledgementsMigration =
  defineLocalSqliteMigration({
    id: '0015-local-owner-delivery-acknowledgements',
    statements: [
      `
CREATE TABLE "QingLong3LocalOwnerDeliveryAcknowledgements" (
  "mutation_id" TEXT PRIMARY KEY NOT NULL,
  "kind" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "project_id" TEXT,
  "subject_id" TEXT,
  "credential_id" TEXT,
  "challenge_id" TEXT,
  "fact_digest" TEXT NOT NULL,
  "delivery_digest" TEXT NOT NULL,
  "ttl_ms" INTEGER NOT NULL,
  "acknowledged_at_ms" INTEGER NOT NULL,
  "provisioning_mutation_id" TEXT,
  "challenge_mutation_id" TEXT,
  FOREIGN KEY ("provisioning_mutation_id")
    REFERENCES "QingLong3LocalIdentityProvisionings" ("mutation_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("challenge_mutation_id")
    REFERENCES "QingLong3LocalOwnerBootstrapChallenges" ("issue_mutation_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_owner_delivery_ack_mutation_check CHECK (
    length("mutation_id") = 36
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_request_check CHECK (
    length("request_id") BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_digest_check CHECK (
    length("fact_digest") = 64
    AND "fact_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("delivery_digest") = 64
    AND "delivery_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_time_check CHECK (
    "ttl_ms" > 0 AND "acknowledged_at_ms" >= 0
  ),
  CONSTRAINT ql3_local_owner_delivery_ack_shape_check CHECK (
    (
      "kind" = 'credential'
      AND "project_id" IS NULL
      AND length("subject_id") = 26
      AND "subject_id" GLOB 'usr_*'
      AND "subject_id" NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length("credential_id") = 26
      AND "credential_id" GLOB 'own_*'
      AND "credential_id" NOT GLOB '*[^A-Za-z0-9_-]*'
      AND "challenge_id" IS NULL
      AND "provisioning_mutation_id" = "mutation_id"
      AND "challenge_mutation_id" IS NULL
      AND "ttl_ms" BETWEEN 600000 AND 604800000
    )
    OR (
      "kind" = 'challenge'
      AND length("project_id") BETWEEN 1 AND 128
      AND "subject_id" IS NULL
      AND "credential_id" IS NULL
      AND length("challenge_id") = 22
      AND "challenge_id" NOT GLOB '*[^A-Za-z0-9_-]*'
      AND "provisioning_mutation_id" IS NULL
      AND "challenge_mutation_id" = "mutation_id"
      AND "ttl_ms" BETWEEN 60000 AND 1800000
    )
  )
)
      `,
    ],
  });
