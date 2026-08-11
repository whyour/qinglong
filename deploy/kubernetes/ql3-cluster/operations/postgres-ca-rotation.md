# PostgreSQL CA overlap rotation

This runbook defines the operator-neutral QingLong 3.0 trust transition. It
does not elect or promote PostgreSQL and does not replace the database
operator's fencing procedure.

## Preconditions

- The runtime, migration and Worker-ingress URLs target one stable read-write
  FQDN. Their `verify-full` servername is an explicit DNS name covered by the
  endpoint certificate SAN; IP literals and implicit servername inference are
  rejected.
- The endpoint routes new connections only to a writable primary. Every new
  QingLong activation independently requires `pg_is_in_recovery() = false` and
  `transaction_read_only = off`.
- The database operator has a reviewed primary fencing procedure and, when
  zero acknowledged-write loss is claimed, a synchronous `remote_apply` or
  equivalent RPO-0 policy.
- Three non-secret files are prepared: `old-ca.pem`, `overlap-ca.pem`, and
  `new-ca.pem`. The overlap file must be the exact union of old and new trust
  anchors. It may retain a shared root or intermediate, but the transition
  must introduce and retire at least one anchor.

Build the package and validate the transition before touching a Secret:

```bash
pnpm audit:postgres-ca-overlap:ql3 -- \
  --old=/absolute/path/old-ca.pem \
  --overlap=/absolute/path/overlap-ca.pem \
  --new=/absolute/path/new-ca.pem
```

Record the returned v1 contract, counts and SHA-256 set digests with the
change. The auditor reuses the production bounded CA loader: every file must
be an absolute, non-group/world-writable regular file containing 1–16 unique
CA certificates and no trailing data.

## Phase A: expand trust

1. Update each authority's Secret independently to the exact overlap bundle:
   runtime, migration and Worker ingress must not be merged into one Secret.
2. Roll the runtime Deployment. Do not rely on kubelet's projected-Secret
   symlink update: QingLong reads the bundle only during a new activation.
3. Wait for every old runtime Pod to terminate and every replacement to pass
   TLS, writable-primary readiness, schema/role readiness, startup recovery
   and lifecycle activation.
4. If Worker ingress is enabled, roll and verify it through its independent
   database Pool. Run the migration Job only when a reviewed migration is
   actually required; CA rotation alone does not authorize DDL.

Do not rotate the server certificate while any QingLong Pod still uses the
old-only bundle.

## Phase B: rotate the endpoint certificate

Use the PostgreSQL operator or reviewed proxy procedure to install a
certificate chaining to the new trust anchor. Preserve the stable FQDN and
prove:

- the certificate SAN covers the configured servername;
- the endpoint still routes only to the externally fenced writable primary;
- existing QingLong Pods remain ready with the overlap bundle;
- a fresh QingLong activation establishes a new TLS connection and passes the
  complete readiness/recovery gate.

Force a controlled QingLong rollout after the server certificate changes.
This removes ambiguity from long-lived connections that were established
before the rotation.

## Phase C: contract trust

1. Confirm every runtime and Worker-ingress Pod was activated after the
   endpoint certificate rotation.
2. Replace each projected overlap bundle with the exact new-only bundle.
3. Roll each workload again and wait for all readiness gates.
4. Retire the old CA only after no old-only Pod, migration Job or database
   endpoint certificate remains.

Keep the overlap bundle and old server key material under the database
operator's approved rollback retention policy; do not put private keys in
QingLong Secrets or evidence.

## Rollback

- Before Phase B, restore old-only bundles and roll workloads.
- During Phase B, keep the overlap bundle. Either repair the new certificate
  or restore the old endpoint certificate through the operator; do not
  contract trust.
- During or after Phase C, restore the overlap bundle first and roll QingLong
  before reverting the endpoint certificate. Removing the new trust anchor
  first can strand every new activation.
- A failed activation stays not-ready. Do not weaken `verify-full`, point
  QingLong at a standby, or revive the old activation in place.

## Required evidence and remaining boundary

Capture the CA-overlap audit JSON, Secret resource versions, Deployment
revisions, replacement Pod identities, configured FQDN/servername, endpoint
certificate serial/fingerprint, readiness timestamps and operator fencing
record. Never record database passwords, private keys or bearer material.

This runbook and local auditor prove the bundle topology and rollout ordering.
They are not evidence that a specific operator/proxy performed TLS routing,
certificate rotation, node/storage STONITH or Kubernetes control-plane
failover. A production release must execute this runbook against the selected
operator and retain its independent evidence.
