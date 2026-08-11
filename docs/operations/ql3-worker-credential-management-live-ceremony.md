# QingLong 3.0 Worker Credential Management External OIDC Ceremony

This operation records one external-identity, two-User management ceremony. It creates and approves a
secret-free Worker credential plan, then inspects it without consuming the approval or executing credential
delivery.

It is a short-lived operator command, not a controller. Run it only against an already reviewed Worker
management endpoint. A successful local/K3s fixture is not a substitute for this external report.

## Private inputs

Prepare five canonical absolute paths:

- mode 0600 production client config using the exact Worker endpoint path, TLS server name, CA file, client
  certificate file, matching private-key file and a 1–30 second timeout;
- mode 0600 requester assertion;
- mode 0600 reviewer assertion for a different User from the same external issuer;
- mode 0600 ceremony JSON;
- an unused output path in a canonical private directory.

Both assertions must use:

```text
aud=qinglong3-worker-credential-management
typ=ql3-worker-credential-management+jwt
ql3_purpose=worker-credential-management
```

The client certificate is a separate transport-possession factor. It must be issued by the manager's reviewed
client CA, be absent from the current CRL and must not be reused as an assertion-signing key or Worker execution
identity. A valid certificate never substitutes for either external User assertion.

The ceremony JSON has this exact top-level shape:

```json
{
  "schemaVersion": 1,
  "planRequest": {
    "actionRef": "worker-credential:REVIEWED_WORKER:REVIEWED_GENERATION",
    "authorityProjectId": "REVIEWED_AUTHORITY_PROJECT",
    "action": "rotate",
    "deliveryId": "REVIEWED_UUID",
    "workerId": "REVIEWED_WORKER",
    "credentialId": "REVIEWED_NEW_CREDENTIAL",
    "previousCredentialId": "REVIEWED_PREVIOUS_CREDENTIAL",
    "credentialNotBeforeAtMs": 0,
    "credentialExpiresAtMs": 0,
    "deploymentTargetDigest": "REVIEWED_64_LOWERCASE_HEX_DIGEST",
    "deploymentGeneration": "REVIEWED_GENERATION"
  },
  "approvalRequestId": "REVIEWED_APPROVAL_ID",
  "approvalAuditEventId": "REVIEWED_UUID",
  "requesterDecisionId": "REVIEWED_SELF_DENY_PROBE_ID",
  "requesterDecisionAuditEventId": "REVIEWED_UUID",
  "reviewerDecisionId": "REVIEWED_REVIEWER_DECISION_ID",
  "reviewerDecisionAuditEventId": "REVIEWED_UUID",
  "decisionReasonCode": "reviewed",
  "inspectionId": "REVIEWED_INSPECTION_ID"
}
```

Replace both timestamps with valid future millisecond values accepted by the Worker management plan contract.
Use new identifiers dedicated to evidence; do not reuse a production delivery that an executor may consume.

## Run and audit

```bash
export QL3_WORKER_CREDENTIAL_MANAGEMENT_LIVE_CEREMONY=1

pnpm evidence:worker-management-live-ceremony:ql3 -- \
  --config=/absolute/private/client.json \
  --requester-assertion=/absolute/private/requester.jwt \
  --reviewer-assertion=/absolute/private/reviewer.jwt \
  --ceremony=/absolute/private/ceremony.json \
  --output=/absolute/private/worker-management-ceremony.json

unset QL3_WORKER_CREDENTIAL_MANAGEMENT_LIVE_CEREMONY

pnpm audit:worker-management-live-ceremony:ql3 -- \
  --report=/absolute/private/worker-management-ceremony.json
```

The runner performs exactly five calls: requester plan, requester propose, requester self-decision rejection,
reviewer decision and reviewer inspect. It fails if self-decision is accepted, if the resulting approval is not
approved by the reviewer, or if inspect observes a dispatch/consumption.

The report contains no raw assertion, subject, JTI, request ID, Worker identifier, Project identifier, token,
Secret, DSN or private key. Retain it with the IdP/operator change record and the independent durable-audit
evidence.

## Collect independent durable-audit evidence

Create a short-lived PostgreSQL login role outside the QingLong migration stream. It must not inherit or be
granted any QingLong runtime role:

```sql
CREATE ROLE ql3_worker_management_evidence
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE qinglong
  TO ql3_worker_management_evidence;
GRANT USAGE ON SCHEMA ql3
  TO ql3_worker_management_evidence;
GRANT SELECT ON
  ql3.worker_credential_management_plans,
  ql3.approval_requests,
  ql3.security_audit_events
  TO ql3_worker_management_evidence;
```

Set its password through the deployment's private credential mechanism, not a checked-in SQL file. Prepare a
mode 0600 libpq service file and an independently protected passfile. The service entry should use
`sslmode=verify-full`, the reviewed hostname and an absolute CA path; do not put a DSN on the command line.

Run the second collector only after the ceremony report has passed its offline audit:

```bash
export QL3_WORKER_CREDENTIAL_MANAGEMENT_DURABLE_AUDIT_EVIDENCE=1

pnpm evidence:worker-management-durable-audit:ql3 -- \
  --ceremony-report=/absolute/private/worker-management-ceremony.json \
  --ceremony=/absolute/private/ceremony.json \
  --pg-service-file=/absolute/private/pg_service.conf \
  --pg-service=ql3_worker_management_evidence \
  --output=/absolute/private/worker-management-durable-audit.json

unset QL3_WORKER_CREDENTIAL_MANAGEMENT_DURABLE_AUDIT_EVIDENCE

pnpm audit:worker-management-durable-audit:ql3 -- \
  --report=/absolute/private/worker-management-durable-audit.json
```

The collector rejects a role that can read any other `ql3` table, mutate any `ql3` table, or become a
privileged QingLong role. It observes exactly two durable audit rows: proposal and reviewer decision. The
requester's rejected self-decision must have no audit row because separation-of-duty fails before the database
update/audit insert transaction can commit. The v1 evidence contract requires PostgreSQL 18.4 or a later
security patch in the reviewed 18.x major.

After retaining the report, revoke the three SELECT grants, schema usage and database connect grant, then drop
the short-lived role according to the deployment's credential revocation procedure. Do not retain its passfile
with the low-sensitive evidence reports.

If the runner stops after creating durable facts, inspect them before using any new identifiers. Do not infer
rollback from a missing response and do not hand this evidence-only approval to the credential executor.
