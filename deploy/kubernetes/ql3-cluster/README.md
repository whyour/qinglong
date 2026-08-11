# QingLong 3.0 Cluster deployment baseline

This directory is separate from `deploy/kubernetes/base`, which remains the
single-replica QingLong 2.x SQLite deployment. Do not scale the 2.x
`StatefulSet` to emulate a QingLong 3.0 control plane.

The 3.0 baseline runs two stateless `cluster-control` replicas. It requires an
already migrated PostgreSQL 16–18 database behind one stable read-write
endpoint. The endpoint must use certificate hostname verification and must
provide externally managed primary fencing. QingLong does not elect or promote
database nodes.

## Build the incubation image

Build from the repository root:

```bash
docker build \
  --file deploy/containers/ql3-cluster-control/Dockerfile \
  --tag qinglong3-cluster-control:3.0.0-alpha.0 \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  .
```

Build the separate short-lived admin image without widening the resident
control-plane image:

```bash
docker build \
  --file deploy/containers/ql3-cluster-admin/Dockerfile \
  --tag qinglong3-cluster-admin:3.0.0-alpha.0 \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  .
```

The admin image has its own builder and production locks. Its five production
roots resolve to 84 external packages and it adds only `runtime-core`,
`cluster-postgres` and `cluster-admin`. Kubernetes client code and the admin
database role therefore exist only in an ephemeral Job image, never in
`cluster-control`.

The runtime image installs only the 43 external packages reachable from the
five exact production roots in its production-only lock plus `runtime-core`,
`cluster-postgres` and `cluster-control`: 46 runtime components in total. The
builder uses a separate lock for TypeScript and type declarations, so no
`@types/*` package enters the runtime image. It does not install the QingLong
2.x root dependency tree.

Generate both reviewed CycloneDX SBOMs and audit the release contract:

```bash
pnpm sbom:cluster-image:ql3 --image=control
pnpm sbom:cluster-image:ql3 --image=admin
pnpm audit:image-release:ql3
```

The admin image resolves 84 external plus 3 internal components. Its production
closure legitimately contains the upstream runtime dependency
`@types/js-yaml` from `@kubernetes/client-node`; the exact production lock, not
the package-name prefix, is authoritative. TypeScript, root devDependencies and
every component outside the selected lock closure remain rejected.

CI builds and reconciles both inventories natively on amd64 and arm64. The
`ql3-image-release.yml` workflow publishes independent
`qinglong3-cluster-control`, `qinglong3-cluster-control-ai`,
`qinglong3-cluster-admin` and `qinglong3-local-application` GHCR manifests for
`v3.*`; the local profile does not merge Cluster authority into its image. Each
image receives its own immutable digest, BuildKit SBOM and maximum provenance,
Cosign keyless signature, GitHub provenance and reviewed application SBOM.
Before any matrix job can succeed, it reads that image's
digest back from GHCR, audits the exact amd64/arm64 manifest and one-to-one
BuildKit attestation bindings, verifies the exact Cosign workflow identity,
and independently verifies GitHub SLSA and CycloneDX OCI bundles against the
source commit and ref.

No publisher receives registry or OIDC write authority until both private
release-evidence jobs and the operating-system vulnerability matrix succeed.
The Cluster DR job re-audits the CloudNativePG, Barman and cert-manager locks,
then accepts only a mode-`0600` live report from the commit-scoped private mount
whose source revision exactly matches the release and whose age is at most 24
hours. See
[`docs/operations/ql3-cloudnativepg-dr-release-evidence.md`](../../../docs/operations/ql3-cloudnativepg-dr-release-evidence.md)
for the evidence handoff contract.

CI also builds one offline multi-architecture OCI layout per image with
BuildKit SPDX and maximum SLSA provenance. Its bounded auditor hashes every
referenced blob, rejects unreferenced content, checks the selected image's
platform config and requires its exact 46- or 87-component npm closure in each
platform SPDX:

```bash
pnpm audit:cluster-oci-layout:ql3 \
  --image=control \
  --layout=/absolute/path/to/extracted-oci-layout \
  --expected-revision=YOUR_SOURCE_REVISION

pnpm audit:cluster-oci-layout:ql3 \
  --image=admin \
  --layout=/absolute/path/to/extracted-admin-oci-layout \
  --expected-revision=YOUR_SOURCE_REVISION

pnpm audit:cluster-remote-manifest:ql3 \
  --manifest=/absolute/path/to/imagetools-raw-index.json \
  --expected-image=ghcr.io/owner/qinglong3-cluster-control \
  --expected-digest=sha256:...
```

The existence of the workflow is not publication evidence. Before production
rollout, record a successful release run for both image repositories,
independently verify each signature and attestation set, and pin both resulting
`sha256:` digests. Never treat the version tag or the control image's proof as
authority for the admin Job.

The committed CloudNativePG control, migration and Plugin Package recovery overlays use
an all-zero SHA-256 digest as an intentionally unpullable fail-closed
placeholder. A private deployment overlay must replace the control placeholder
with the verified `qinglong3-cluster-control` digest and the recovery
placeholder with the independently verified `qinglong3-cluster-admin` digest.
Static deployment audit rejects replacing either production-oriented reference
with `newTag`.

## CloudNativePG production profile

The reviewed production database profile is CloudNativePG 1.30.0 with
PostgreSQL 18.4. Its source manifests live under
`operators/cloudnative-pg`; `operator-lock.json` records the exact operator and
operand OCI index digests plus their amd64/arm64 manifests. The operator is a
cluster-only dependency and never enters edge, standalone or Worker packages.

The committed Cluster requires three schedulable nodes. It uses required
hostname anti-affinity, `remote_apply`, synchronous `ANY 1`, required data
durability and failover quorum. It exposes only the operator-managed
`ql3-postgres-rw` primary Service. If only one database instance remains,
mutations can stop until a synchronous replica is available; do not weaken
this to asynchronous commit and continue to claim RPO 0.

Install the locked operator with cluster-admin authority before applying the
QingLong resources. The lock records the official release manifest and
Sigstore bundle inputs, but it is not itself signature verification evidence.
Save the actual asset digest, Cosign verification and operator rollout status
in the release record.

Create the Namespace and the role/runtime Secrets through a Secret manager. Use
`operators/cloudnative-pg/credentials.example.yaml` only as a schema example;
it is intentionally excluded from Kustomize and must never be applied with
placeholder values. Then use this order:

```bash
kubectl apply -f deploy/kubernetes/ql3-cluster/base/namespace.yaml

# Create the thirteen role basic-auth Secrets, ql3-cluster-control-runtime,
# ql3-cluster-worker-ingress, and the reviewed Plugin Package
# publisher-trust/config ConfigMaps here.

kubectl apply -k deploy/kubernetes/ql3-cluster/operators/cloudnative-pg
kubectl -n qinglong3-system wait \
  --for=condition=Ready cluster/ql3-postgres \
  --timeout=15m
kubectl -n qinglong3-system get \
  cluster,databaserole,database,service,secret

kubectl create -k deploy/kubernetes/ql3-cluster/operations/cloudnative-pg
kubectl -n qinglong3-system wait \
  --for=condition=Complete job/ql3-cluster-migration \
  --timeout=10m
kubectl -n qinglong3-system logs job/ql3-cluster-migration

kubectl create -k \
  deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/cloudnative-pg
kubectl -n qinglong3-system wait \
  --for=condition=Complete job/ql3-plugin-package-recovery \
  --timeout=10m
kubectl -n qinglong3-system logs job/ql3-plugin-package-recovery

kubectl apply -k deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg
kubectl -n qinglong3-system rollout status deployment/ql3-cluster-control
```

Authenticated Plugin Package management is a separate opt-in deployment. It is
not part of `base`, `operations`, or the CloudNativePG control overlay. Do not
apply it until the database migration and recovery gates above have completed,
the management server certificate has been issued, and the identity keyset has
been independently reviewed. Copy
`operations/plugin-package-management/config.example.yaml` into a private
overlay; never apply its placeholder values.

The CloudNativePG variant reads only the operator-managed
`ql3-postgres-package-manager-auth` credential and `ql3-postgres-ca`. Create the
separate `ql3-plugin-package-management-tls` Secret and
`ql3-plugin-package-management-identity` Secret through the deployment
controller, replace the all-zero admin image digest, then apply:

```bash
kubectl apply -k \
  deploy/kubernetes/ql3-cluster/operations/plugin-package-management/cloudnative-pg
kubectl -n qinglong3-system rollout status \
  deployment/ql3-plugin-package-management
```

Worker credential management is a second, separately opt-in Deployment; it is
not a sidecar of Plugin Package management and never receives the Worker
credential executor credential, TokenRequest authority or credential pepper.
Create the TLS and public identity keyset Secrets from
`operations/worker-credential-management/config.example.yaml`, replace the
independent all-zero admin-image digest in a private overlay, then apply:

```bash
kubectl apply -k \
  deploy/kubernetes/ql3-cluster/operations/worker-credential-management/cloudnative-pg
kubectl -n qinglong3-system rollout status \
  deployment/ql3-worker-credential-management
```

Task/Trigger automation management is a third independent, opt-in Deployment.
It is not added to Edge/Standalone: those Profiles retain the short-lived
`ql3-task` and `ql3-trigger` path with zero management listener and zero
PostgreSQL Pool. For Cluster, create the mTLS/CRL and purpose-bound public
identity Secrets from `operations/automation-management/config.example.yaml`,
replace the all-zero Admin image digest and CA/CRL annotation digests in a
private overlay, then apply:

```bash
kubectl apply -k \
  deploy/kubernetes/ql3-cluster/operations/automation-management/cloudnative-pg
kubectl -n qinglong3-system rollout status \
  deployment/ql3-automation-management
```

The service accepts only TLS 1.3 clients with reviewed certificates plus a
strong User assertion bound to audience `qinglong3-automation-management`, JWT
type `ql3-automation-management+jwt` and purpose `automation-management`.
Plugin Package and Worker assertions cannot cross this boundary. Its two Pods
open at most four aggregate `ql3_automation_manager` PostgreSQL connections;
base egress is DNS-only and the CloudNativePG overlay adds only the exact
database Pods on TCP 5432. It has no ServiceAccount token or Kubernetes API
authority. The complete deployment and request contract is documented in
[`docs/operations/ql3-automation-management.md`](../../../docs/operations/ql3-automation-management.md).

Operators invoke it through the separate `ql3-automation-client` binary or the
opt-in `operations/automation-management-client` one-shot Job. The Job request
is an immutable Secret because Task definitions may contain sensitive source;
it has no RBAC/token, does not retry a business command, and is not included by
the shared operations Kustomization.

Human Approval management is a fourth independent, opt-in Deployment. It does
not grant MCP write authority and does not consume, dispatch or execute an
Approved Action. Create its mTLS/CRL and Approval-purpose public identity
Secrets from `operations/approval-management/config.example.yaml`, replace the
Admin image and CA/CRL digest sentinels in a private overlay, then apply:

```bash
kubectl apply -k \
  deploy/kubernetes/ql3-cluster/operations/approval-management/cloudnative-pg
kubectl -n qinglong3-system rollout status \
  deployment/ql3-approval-management
```

The ClusterIP service uses port 8447 and accepts only TLS 1.3 mTLS plus a strong
User assertion with audience `qinglong3-approval-management`, JWT type
`ql3-approval-management+jwt` and purpose `approval-management`. Its two Pods
open at most four aggregate `ql3_approval_manager` PostgreSQL connections. Base
egress is DNS-only; the CloudNativePG overlay adds only exact database Pods on
TCP 5432. It has no ServiceAccount token or Kubernetes API authority.

Operators use the separate `ql3-approval-client` binary or the opt-in
`operations/approval-management-client` one-shot Job. The Job has no RBAC or
token, retries only `/readyz`, invokes the business command once with
`backoffLimit: 0`, and is absent from the shared operations Kustomization. See
[`docs/operations/ql3-cluster-approval-management.md`](../../../docs/operations/ql3-cluster-approval-management.md)
for the exact inspect → review → decide ceremony and response-loss rules.

A private one-node development overlay may explicitly use one Pod and Pool 1,
and remove the PDB/required anti-affinity. That shape is not HA and must not
replace the reviewed base. Larger installations must coordinate replica count,
database role connection limits and transport quotas instead of enabling
unbounded autoscaling.

The automation-management live gate is deliberately separate from the Worker
and Plugin Package gates:

```bash
QL3_AUTOMATION_MANAGEMENT_KUBERNETES_LIVE=1 \
QL3_CNPG_OPERATOR_MANIFEST_FILE=/owner-private/cloudnative-pg-1.30.0.yaml \
pnpm test:automation-management-kubernetes-live:ql3
```

It creates one disposable K3s server plus two agents, three CloudNativePG
PostgreSQL 18.4 instances and two manager Pods on distinct nodes. It verifies
all 54 migrations/capability v53, thirteen least-privilege roles, exact-Pod TLS
1.3/mTLS requests, identity and certificate revocation rollouts, primary
promotion, database readiness fencing/fresh-Pod recovery, CNI ingress/egress
and RBAC denial. K3s Flannel is embedded in the reviewed K3s distribution, so
the gate binds the exact K3s image, three fresh Ready nodes with unique
PodCIDRs, server VXLAN annotations and actual positive/negative network probes;
it does not invent a `kube-flannel` DaemonSet. The fixture runs on one Docker
host and is not infrastructure STONITH or Kubernetes control-plane HA evidence.
It adds no workspace package or Profile runtime dependency.

The committed Pod-template annotations
`qinglong.io/worker-credential-management-client-ca-sha256` and
`qinglong.io/worker-credential-management-client-crl-sha256` are all-zero
evidence sentinels. A private production overlay must replace them with the
SHA-256 of the exact projected CA and CRL bundle bytes. Every later trust or
revocation change must update the corresponding annotation and complete a
zero-unavailable rollout; do not grant the evidence collector Secret read or
Deployment mutation authority. CA rollover follows the bounded old → overlap
→ new procedure in
[`docs/operations/ql3-worker-credential-management-ca-rollover.md`](../../../docs/operations/ql3-worker-credential-management-ca-rollover.md).
The two-phase certificate-revocation procedure is documented in
[`docs/operations/ql3-worker-credential-management-pki-rotation-evidence.md`](../../../docs/operations/ql3-worker-credential-management-pki-rotation-evidence.md).

The external IdP assertion must bind the Worker-specific audience
`qinglong3-worker-credential-management`, JWT type
`ql3-worker-credential-management+jwt`, and purpose
`worker-credential-management`. Plugin Package management assertions are
rejected even if they use the same issuer and signing key; do not add a legacy
purpose fallback in a private overlay.

It serves TLS 1.3 on ClusterIP port 8444 and admits only same-namespace Pods
labelled `qinglong.io/worker-credential-management-client=true`. Its two Pods
open at most four aggregate manager-role PostgreSQL connections. The base
NetworkPolicy allows only DNS egress; the CloudNativePG overlay adds only the
exact PostgreSQL cluster on TCP 5432. This management Deployment can create and
review secret-free plans, but it cannot execute a delivery.

An operator workstation invokes management through the separate, opt-in
`operations/worker-credential-management-client` Job documented in
[`docs/operations/ql3-worker-credential-management-client.md`](../../../docs/operations/ql3-worker-credential-management-client.md).
Copy its example inputs to a private per-command directory, replace the
short-lived strong-User assertion and reviewed CA, and pin the independent
Admin image digest in a private overlay. The Job has no RBAC or ServiceAccount
token. Its init container retries only the TLS 1.3 `/readyz` probe; the main
container invokes the production client exactly once with `backoffLimit=0`.
The checked-in operation is not included by `operations/kustomization.yaml`
and its all-zero image digest intentionally fails closed.

Approved delivery uses the different caller-driven executor operation documented in
[`docs/operations/ql3-worker-credential-execution.md`](../../../docs/operations/ql3-worker-credential-execution.md);
never widen this Deployment with executor credentials or Kubernetes API access.
The live K3s gate has executed that operation with the production Admin image:
one Job published the approved delivery with a 600-second issuer token and a
second independent Job replayed the exact command without another TokenRequest.
Private overlays still must resolve the exact pre- and/or post-DNAT API
destination enforced by their own CNI.

The manager-specific live gate is:

```bash
pnpm test:worker-management-kubernetes-live:ql3
```

It starts three disposable K3s nodes and PostgreSQL 18, runs two manager Pods
on distinct nodes, and exercises the production TLS 1.3 client against each
exact Pod. It proves 8 admitted plus 8 quota-limited requests, cross-Pod
semantic replay without an extra quota receipt, identity generations 1→2→3,
rollback fail-closed, database-failure readiness withdrawal with liveness
preserved, and recovery only through fresh Pods. It also loads the checked-in
client ServiceAccount, NetworkPolicy and Job with only a test-image
substitution, then proves immutable inputs, zero projected token, successful
readiness init, one successful main-container execution and zero restarts.
Separate load-generating client Pods may retry only no-response transport
failures with the same idempotency key; HTTP rejections are never retried.

The Service is ClusterIP-only and serves TLS 1.3 on port 8443. Its NetworkPolicy
accepts only same-namespace Pods labelled
`qinglong.io/plugin-package-management-client=true`. A gateway in another
namespace needs an explicitly reviewed private NetworkPolicy patch; do not
replace the Service with an unauthenticated public LoadBalancer.
The base policy denies all business egress and allows only kube-system DNS.
The CloudNativePG operation adds exactly same-namespace
`cnpg.io/cluster=ql3-postgres` TCP 5432. External PostgreSQL or a different DNS
implementation requires an exact private overlay; never add an empty egress
rule or namespace-wide destination.
The server certificate must cover the DNS name used by that client, normally
`ql3-plugin-package-management.qinglong3-system.svc`, and clients must verify
the issuing CA and hostname.

For an operator workstation outside the ClusterIP network, use the reviewed
`ql3-plugin-package-client-kubernetes` workflow in
[`docs/operations/ql3-plugin-package-management-client.md`](../../../docs/operations/ql3-plugin-package-management-client.md).
It uses one Kubernetes Pod port-forward and then performs the same end-to-end
TLS 1.3 management request. It does not create a Job or persist the assertion
in a Kubernetes Secret. Pod port-forward is a separate Kubernetes RBAC ingress
authority and must not be reported as proof that the labelled-Pod
NetworkPolicy path was exercised.

Each of the two reviewed replicas requests 100 millicores and 128 MiB, is capped
at 1 CPU and 512 MiB, opens at most two Package manager database connections,
accepts at most 32 established TLS connections, admits at most 16 concurrent
management requests and retains at most 512 process-local peer buckets. The
aggregate reviewed request floor is therefore 200 millicores/256 MiB with four
database connections. A one-node development overlay may deliberately reduce
replicas and remove the PDB/required anti-affinity, but that shape is not the
production HA baseline.

The identity Secret contains public verification material, not a credential,
but Secret projection provides an integrity domain that the ConfigMap-writing
recovery ServiceAccount cannot modify. Rotate it atomically by increasing `generation`,
overlap old and new public keys, then append the retired `kid` to
`revokedKids`; never reuse or remove a revoked ID. Every authenticated request
reopens the projected file and fails closed on malformed, unavailable,
rewritten or process-observed rollback state. Kubernetes projection propagation
is not instantaneous, so production authentication additionally checks the
PostgreSQL durable keyset ledger on every reload; an old projection cannot
become trusted by restarting every replica. Server TLS certificate rotation
requires a controlled Pod rollout because TLS material is loaded only at
process startup.

This deployment exposes only `propose`, `decide`, and low-sensitive `inspect`.
It has no Kubernetes API token or RBAC, no Registry credential, and no Package
executor/admin/runtime database identity. Process-local rate limiting is a
bounded anonymous-traffic shield, not a distributed quota. Authenticated
requests additionally use the PostgreSQL database clock and one bounded
`Project + User subject + operation` bucket shared by every replica. The
reviewed defaults are 30 propose, 60 decide and 600 inspect operations per
60-second window; exact retries reuse the in-row receipt and do not consume a
second unit. Keep the deployment disabled from production ingress until the
real two-user IdP ceremony and live ingress gates are complete.

The operator owns LOGIN role lifecycle, database instances, promotion,
Services and certificates. `pg-0017-database-role-grants` establishes the
baseline grants; `pg-0022-plugin-package-authority-split` advances
`control-core` to capability v21, removes Package authority from `ql3_admin`
and assigns exact grants to `ql3_package_manager` and
`ql3_package_executor`. `pg-0023-plugin-package-management-quota` advances the
contract to v22 and grants only `ql3_package_manager` SELECT/INSERT/UPDATE on
the bounded quota table.
`pg-0024-plugin-package-identity-keyset-ledger` advances the contract to v23
and grants the same manager role access to the bounded single-row identity
ledger; all other runtime roles remain denied.
`pg-0025-plugin-package-materialized-revisions` advances the contract to v24
and grants only `ql3_package_executor` SELECT/INSERT on immutable semantic
revisions; runtime, admin, manager and worker-ingress roles remain denied.
`pg-0047-worker-credential-management-plans` adds the isolated
`ql3_worker_credential_manager` and `ql3_worker_credential_executor` roles;
the former can plan and manage approvals but cannot mutate credentials, while
the latter can consume approved plans and append delivery facts but cannot
create plans. `pg-0052-automation-management` adds the isolated
`ql3_automation_manager`, which can mutate only the reviewed Task/Trigger and
automation identity/audit authority.
`pg-9010-ai-plugin-package-prompt-output-tombstones` adds the optional
`ql3_ai_maintenance` role. It can read terminal Prompt evidence, append a
content-free tombstone and delete the matching encrypted output Artifact; it
cannot execute models, mutate Runs, update tombstones or inherit runtime/admin
authority. `pg-9011-ai-plugin-package-prompt-output-key-retirements` reuses
that short-lived role to append content-free preparation/completion facts only
after live ciphertext reaches zero. `ql3_runtime` can only read preparation so
an Artifact insert can acquire the same key-scoped transaction fence and reject
a retired key; it cannot append, update or delete retirement facts. Production
key material deletion remains an explicit operator authority and is not a
background CronJob. All thirteen roles must stay
non-superuser and cannot create databases, roles, replication sessions or
bypass RLS. The `qinglong` Database is owned by the short-lived
`ql3_migration` role.

Prompt output retention is an explicit, caller-driven operation, not a
CronJob. Copy `operations/prompt-output-gc/config.example.yaml` to private
deployment configuration, replace every Project/revision/retention value and
recompute its policy digest, then create that immutable ConfigMap separately.
The example ConfigMap is intentionally absent from every Kustomization so an
unreviewed placeholder Project can never be applied by the repository overlay.
Render and apply
`operations/prompt-output-gc/cloudnative-pg` only when one bounded collection
page is requested. The Job has `backoffLimit: 0`, no Kubernetes API token,
uses only `ql3-postgres-ai-maintenance-auth`, and can egress only to DNS and
the CloudNativePG pods on 5432. Its JSON result exposes only scanned,
tombstoned, skipped and hasMore. Delete the completed named Job before an
operator explicitly requests another page; `hasMore=true` never creates an
automatic retry or background cadence.

Encrypted durable Prompt output is a separate opt-in Cluster AI composition.
Use both `components/cluster-ai` and `components/cluster-ai-prompt-output` as
shown by `overlays/cluster-ai-prompt-output-example`. The second component
mounts only `ql3-prompt-output-keyring/keyring.json` as required, read-only
`0440` material and grants no Kubernetes API authority. It does not create the
Secret, so missing material fails the opted-in runtime closed while the default
Cluster and default Cluster AI deployments remain live-output-only.

Prompt output key retirement is a separate destructive, caller-driven
operation. It is not part of the default operations Kustomization and it does
not provision or rotate keys. Run it only when the Cluster Prompt runtime is
already configured to read the same dedicated Secret; retiring an unrelated
Secret would create two material authorities and is unsupported.

The deployment Secret must be named `ql3-prompt-output-keyring` in
`qinglong3-system`, be `type: Opaque`, explicitly mutable, contain exactly one
`keyring.json` data entry, and carry these metadata facts:

```yaml
labels:
  app.kubernetes.io/managed-by: qinglong3
  qinglong.io/prompt-output-keyring: v1
annotations:
  qinglong.io/prompt-output-keyring-generation: "REPLACE_WITH_MANIFEST_GENERATION"
  qinglong.io/prompt-output-keyring-catalog-digest: REPLACE_WITH_CANONICAL_CATALOG_DIGEST
```

`keyring.json` contains encryption material. Create it through the deployment's
Secret manager or external KMS/Secret operator; do not commit it, put it in a
ConfigMap, use `stringData`, or attach a last-applied annotation containing a
copy. First provision and KMS wrapping remain outside QingLong. Active-key
rotation is the separate externally staged
`operations/prompt-output-key-rotation` ceremony; it must not be folded into
retirement or runtime startup.

For one reviewed inactive key, copy `command.example.yaml` into private
configuration and replace all four request identities plus the key ID. Bind the
command to the live Secret UID, not merely its name:

```bash
kubectl -n qinglong3-system get secret ql3-prompt-output-keyring \
  -o jsonpath='{.metadata.uid}{"\\n"}'
```

The base NetworkPolicy intentionally has no PostgreSQL or Kubernetes API
egress. The CloudNativePG overlay adds only exact database Pods on TCP 5432;
your private overlay must also apply
`api-server-egress-patch.example.yaml` after replacing its documentation-only
`192.0.2.1/32:6443` with the actual API server `/32` and TCP port. Never replace
this with `0.0.0.0/0`. The private overlay must include the immutable command
ConfigMap, the CloudNativePG operation, the exact API egress patch, and the
independently verified Admin image digest.

The Job's ServiceAccount can get/update only this exact Secret and can create
only SelfSubjectAccessReview requests. At startup the CLI proves that
get/update are allowed and list/watch/create/delete/patch, other Secrets,
ConfigMaps and Pods are denied. It then uses `ql3_ai_maintenance` to commit the
database preparation, performs one Secret `resourceVersion` CAS, and appends
completion. `backoffLimit: 0` is deliberate: response loss is resolved by
durable facts and exact replay, not blind Job retry. A successful JSON result
contains only low-sensitive identities/digests. Delete the completed named Job
and the per-command ConfigMap after retaining the required audit evidence.

Lost-key verification is a third, offline operation at
`operations/prompt-output-external-recovery`. It runs only in the isolated
`qinglong3-recovery` namespace, has no RBAC, ServiceAccount token, database
connection or network egress, and mounts one deployment-owned PVC read-only.
The external authority must place the signed custody receipt, exact wrapped
blob, externally unwrapped 32-byte material, restored durable key fact,
encrypted Artifact, two-User authorization and pinned public keys in that
workspace. The verifier produces only an authorization-bound content-free
proof; it cannot call the KMS, export plaintext, mutate the production Secret
or reverse retirement. See the operation README for file and permission rules.

After a real external OIDC issuer, three-control-plane/two-worker cluster and
production ingress are available, run the caller-driven exercise. It creates a
dedicated proposal/approval/Audit but never consumes, dispatches, downloads or
activates a Package. Use a reviewed, harmless evidence-only `action-input`.
Every private input/state path below must be canonical mode 0600 and unused
output paths must not already exist.

```bash
export QL3_PLUGIN_PACKAGE_MANAGEMENT_LIVE_EXERCISE=1

pnpm evidence:plugin-package-management-live-exercise:ql3 -- before \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --endpoint=https://management.example.org/api/v3/plugin-packages/management \
  --ca-file=/absolute/private/management-ca.crt \
  --requester-assertion=/absolute/private/requester.jwt \
  --reviewer-assertion=/absolute/private/reviewer.jwt \
  --action-input=/absolute/private/evidence-action.json \
  --output-state=/absolute/private/management-before.json

# Pause: overlap old/new keys, increase generation, rotate the TLS Secret and
# complete a zero-unavailable rollout. Mint old.jwt/new.jwt with enough lifetime
# to reuse the exact same files after the next pause.
pnpm evidence:plugin-package-management-live-exercise:ql3 -- overlap \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --endpoint=https://management.example.org/api/v3/plugin-packages/management \
  --ca-file=/absolute/private/management-ca.crt \
  --input-state=/absolute/private/management-before.json \
  --old-assertion=/absolute/private/old.jwt \
  --new-assertion=/absolute/private/new.jwt \
  --output-state=/absolute/private/management-overlap.json

# Pause: explicitly revoke the old kid, increase generation, keep overlap TLS.
pnpm evidence:plugin-package-management-live-exercise:ql3 -- revoked \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --endpoint=https://management.example.org/api/v3/plugin-packages/management \
  --ca-file=/absolute/private/management-ca.crt \
  --input-state=/absolute/private/management-overlap.json \
  --old-assertion=/absolute/private/old.jwt \
  --new-assertion=/absolute/private/new.jwt \
  --output-state=/absolute/private/management-revoked.json

unset QL3_PLUGIN_PACKAGE_MANAGEMENT_LIVE_EXERCISE
pnpm evidence:plugin-package-management-live-exercise:ql3 -- finalize \
  --input-state=/absolute/private/management-revoked.json \
  --output=/absolute/private/management-exercise.json
```

`before` proves the two-User ceremony plus live ingress/egress with temporary
tokenless/non-root Pods; cleanup failure fails the phase. `overlap` and
`revoked` prove three keyset generations, two TLS generations and three ordered
two-replica readiness snapshots. Each phase writes a new mode 0600 digest-linked
state and stores only assertion SHA-256 values. The digest chain proves
continuity, not host authenticity; preserve operator logs and reviewed rollout
records as the release trust chain.

Collect Kubernetes/PostgreSQL/OIDC facts and derive the final low-sensitive
report:

```bash
chmod 600 /absolute/private/{kubeconfig,management-exercise.json,pg_service.conf}
pnpm evidence:plugin-package-management-live:ql3 -- \
  --kubeconfig=/absolute/private/kubeconfig \
  --context=production \
  --cni-daemonset=kube-system/cilium \
  --cni-container=cilium-agent \
  --cni-name=cilium \
  --exercise=/absolute/private/management-exercise.json \
  --pg-service-file=/absolute/private/pg_service.conf \
  --pg-service=ql3_evidence \
  --output=/absolute/private/plugin-package-management-live.json
```

The named PostgreSQL service must authenticate as `ql3_package_manager`; the
collector passes only `service=ql3_evidence` to `psql` and never reads or emits
the service file. It directly verifies the v23 migration/schema facts, three
durable Audit rows and final keyset ledger. It also queries immutable live image
IDs, distinct Pod/Node UIDs, exact CNI version, three control-plane/two worker
nodes, zero token mount, the exact CloudNativePG NetworkPolicy and negative
manager RBAC. OIDC discovery and JWKS are fetched over HTTPS without redirects
and hashed from their raw responses.

The current collector is deliberately exact for the reviewed CloudNativePG
overlay. A different DNS, CNI workload shape or external PostgreSQL policy needs
a separately reviewed collection profile; do not weaken selectors to make the
default collector pass. Finally validate the generated private report:

```bash
pnpm audit:plugin-package-management-live-evidence:ql3 -- \
  --report=/absolute/private/plugin-package-management-live.json
```

The auditor rejects localhost/IP/reserved test issuers, identical users,
single-factor identity, fewer than two ready replicas on distinct nodes,
capability below v23, unverified ingress/egress denial, incomplete rotation,
false summary gates and any assertion/token/password/DSN/private-key material.
The collector rejects group/world-readable inputs, stale exercises, claimed
gates, broad/empty live NetworkPolicy selectors, non-manager database roles and
OIDC discovery/JWKS mismatch. Passing unit tests, generating a report from
fabricated raw observations or using a self-signed CI identity is not live
evidence.

Both runtime and migration overlays use discrete host/port/database/user/
password configuration, not password-bearing DSN copies. Their hostname and
TLS servername are exactly
`ql3-postgres-rw.qinglong3-system.svc`; user/password come from distinct
basic-auth Secrets. The operator CA is projected from Secret
`ql3-postgres-ca`, key `ca.crt`, into the existing bounded loader path. The
runtime Pod receives only the runtime database credential and API pepper; the
migration Job receives only the migration database credential; the Plugin
Package recovery Job receives only the Package executor credential.

The migration and Plugin Package recovery Jobs have fixed names because they
are Kustomize resources. Before rerunning one, wait for its TTL cleanup or
explicitly delete only that named Job. Migration must complete first; recovery
must then emit `recovery_completed`; only then may the runtime rollout start.
Kustomize renders resources but does not impose this cross-Job/apply ordering,
so a deployment controller must preserve these three separate steps.

Copy
`operations/plugin-package-recovery/config.example.yaml` into a private
deployment overlay. `cluster-identity` must remain stable for the Kubernetes
cluster, `oci-registries` is a comma-separated exact allowlist, and
`publishers.json` contains reviewed Ed25519 public keys. The current resolver
uses HTTPS, rejects redirects and reads no ambient registry credentials. A
Package OCI manifest must contain one QingLong bundle layer and its signature
must be an OCI referrer annotated with the exact PackageLock digest.

Public registries need no additional resource. For a private registry, copy
`operations/plugin-package-recovery/private-registry/credentials.example.json`
outside the checkout, replace every placeholder, restrict the file to the
operator, and create the separately managed Secret:

```sh
chmod 600 /absolute/private/path/credentials.json
kubectl -n qinglong3-system create secret generic \
  ql3-plugin-package-registry-credentials \
  --from-file=credentials.json=/absolute/private/path/credentials.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

Then render/apply
`operations/plugin-package-recovery/private-registry`, which layers on the
CloudNativePG recovery overlay. It projects only `credentials.json` at `0440`
into the short-lived Job and sets
`QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE`; it does not put credentials in
ConfigMaps or grant Secret API access. The v1 file accepts at most 32 unique
exact-allowlist entries using explicit `basic` or `bearer` schemes. The process
does not read Docker config or helpers, never sends a credential to another
registry, retains redirect rejection, and disposes its credential provider
before exit.

Run the static and render gates before touching a cluster:

```bash
pnpm audit:cloudnativepg:ql3
kubectl kustomize deploy/kubernetes/ql3-cluster/operators/cloudnative-pg >/dev/null
kubectl kustomize deploy/kubernetes/ql3-cluster/operations/cloudnative-pg >/dev/null
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/cloudnative-pg \
  >/dev/null
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/private-registry \
  >/dev/null
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/plugin-package-management/cloudnative-pg \
  >/dev/null
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/worker-credential-management/cloudnative-pg \
  >/dev/null
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/automation-management/cloudnative-pg \
  >/dev/null
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/automation-management-client \
  >/dev/null
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/cloudnative-pg \
  >/dev/null
kubectl kustomize deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg >/dev/null
```

Three replicas are not a backup. The Barman CNPG-I contract below defines
continuous WAL, base backups and isolated restore, but the shared profile does
not install an unlocked plugin or create provider credentials. A real operator
failover/fencing drill, CA old→overlap→new→rollback drill and backup/restore
drill remain production release gates.

### Reproducible live operator gate

The opt-in live contract creates an isolated four-node Kind cluster (one
control-plane and three workers), installs the locked operator, schedules one
PostgreSQL instance per worker, runs the reviewed migration and two
cluster-control replicas, then stops the worker hosting the primary. It
requires a different primary and a higher PostgreSQL timeline, observes the
CloudNativePG Lease, restarts the isolated worker, waits for three healthy
instances and rechecks all thirteen role attributes, 54 migrations, capability v53, runtime
readiness and the operator CA Secret. It emits only non-secret JSON evidence
and deletes only its validated `ql3-cnpg-*` Kind cluster unless
`QL3_KEEP_KIND_CLUSTER=1` is explicitly set.

The contract is destructive to that temporary Kind cluster and therefore
fails closed unless explicitly enabled:

```bash
QL3_CLOUDNATIVEPG_LIVE=1 \
  QL3_KIND_BIN=/absolute/path/to/kind \
  QL3_KUBECTL_BIN=/absolute/path/to/kubectl \
  pnpm test:cloudnativepg-live:ql3
```

CI pins Kind v0.31.0, Kubernetes v1.32.8 and the CNPG/PostgreSQL OCI digests.
The successful job JSON is deployment evidence; the existence of the script
or workflow alone is not. This gate does not claim CA rollover or backup
restore coverage.

### Barman Cloud backup and isolated restore

Backup is an explicit cluster-only Kustomize Component under
`components/barman-cloud-backup`. It adds one
`barman-cloud.cloudnative-pg.io` WAL archiver and a daily standby-preferred
base backup. It intentionally excludes the ObjectStore and Secret so a shared
repository checkout cannot apply placeholder credentials or bucket settings.

The candidate lock in `operators/barman-cloud/plugin-lock.json` records the
Barman v0.13.0 release manifest SHA-256, controller/sidecar OCI indexes and
their amd64/arm64 manifests. Run
`pnpm audit:barman-cloud-supply-chain:ql3` to verify it. The lock deliberately
remains `releaseReady: false`.

The certificate authority selection is separately recorded in
`operators/cert-manager/selection-lock.json`. It fixes cert-manager v1.20.3
because that supported release covers the locked Kubernetes 1.32.8 baseline;
v1.21 starts at Kubernetes 1.33. Run
`pnpm audit:cert-manager-selection:ql3`. The selection is not a complete
supply-chain lock: its release SHA and OCI image inventory intentionally remain
empty until external verification is completed. Do not apply either a `latest`
URL or the tag-only upstream manifest directly.

After installing a fully reviewed Barman Cloud plugin/certificate release, copy
`object-store.s3.example.yaml` and `private-overlay.example.yaml` to a private
overlay, replace every placeholder, and create the referenced Secret through a
secret manager. The bucket/prefix must be dedicated to this source Cluster,
use HTTPS and versioning, and have provider object-lock/lifecycle rules that do
not shorten the 30-day Barman retention window.

Audit the shared boundary before applying the private overlay:

```bash
pnpm audit:cloudnativepg-backup:ql3
pnpm audit:barman-cloud-supply-chain:ql3
pnpm audit:cert-manager-selection:ql3
kubectl kustomize \
  deploy/kubernetes/ql3-cluster/operations/cloudnative-pg-restore \
  >/dev/null
kubectl kustomize /absolute/path/to/private-backup-overlay >/dev/null
```

Restore is never in place. Copy
`operations/cloudnative-pg-restore/object-store.s3.example.yaml` into a
separate private operation, use different and preferably read/list-only
credentials, and create `ql3-postgres-restore`. The restore Cluster reads the
source `serverName: ql3-postgres` but has no WAL archiver, so it cannot write
into the recovery source. Do not add
`cnpg.io/skipEmptyWalArchiveCheck`.

A release restore drill must write a unique marker before a completed base
backup and another after it, archive both WAL boundaries, and prove:

- latest restore contains both markers;
- PITR between them contains only the first marker;
- all 54 migrations, capability v53, thirteen non-privileged roles, exact grants,
  three synchronous instances and runtime readiness are intact;
- the evidence report records backup/WAL identity and database/schema/runtime
  RTO plus observed RPO without credentials.

A rendered manifest, three healthy replicas, or a `Backup` Completed condition
is not restore evidence. See
[`ADR-0130`](../../../docs/adr/ADR-0130-cloudnativepg-barman-backup-and-isolated-restore.md).

Validate the resulting private, non-secret report with:

```bash
pnpm audit:cloudnativepg-dr-evidence:ql3 -- \
  --report=/absolute/path/to/private-dr-report.json
```

The verifier requires latest restore, PITR, exact schema/roles, source/recovery
authority separation, certificate rotation continuity and deployment-specific
RPO/database-RTO/application-RTO targets. It rejects credential material and a
summary that marks `passed` while any independent gate is false.

## Required runtime Secret

Create the Secret through your secret manager or a one-shot operator workflow;
do not commit it. This generic DSN example is for a non-operator PostgreSQL
deployment; the CloudNativePG profile above must use its four discrete
basic-auth Secrets instead:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ql3-cluster-control-runtime
  namespace: qinglong3-system
type: Opaque
stringData:
  postgres-runtime-url: postgresql://ql3_runtime:REDACTED@postgres-rw.example.internal:5432/qinglong
  postgres-tls-servername: postgres-rw.example.internal
  postgres-ca.crt: |
    -----BEGIN CERTIFICATE-----
    REPLACE_WITH_OPERATOR_CA_BUNDLE
    -----END CERTIFICATE-----
  api-credential-pepper: REPLACE_WITH_CANONICAL_32_BYTE_BASE64URL
```

The URL must not contain `ssl*` query parameters. TLS is configured separately
and is fixed to `verify-full` in the committed deployment. The servername is
mandatory, must be an explicit DNS name rather than an IP literal, and must
match the endpoint certificate SAN. Only
`postgres-ca.crt` is projected from this Secret into the runtime trust mount;
the URL, servername and pepper remain environment-only values. The CA loader
requires an absolute path to a regular file that is not group/world writable,
1–256 KiB, and contains 1–16 unique PEM X.509 CA certificates with no trailing
data.

The trust bundle is loaded once for each new application activation. Rotate the
Secret and perform a controlled Deployment rollout; an active Pool never
silently changes trust roots in place. Use the
[old → overlap → new runbook](operations/postgres-ca-rotation.md) and its
`audit:postgres-ca-overlap:ql3` preflight rather than replacing a trust root in
one step.

Migration and initial Identity/credential administration intentionally remain
separate, short-lived authorities; the control-plane Pod never receives those
credentials.

## Required Worker ingress Secret

The same control Pod owns a second TLS 1.3/mTLS listener on port 5801, but it
opens a separate `ql3_worker_ingress` Pool. Create this Secret through the
secret manager; do not reuse the API credential pepper or the runtime database
credential:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ql3-cluster-worker-ingress
  namespace: qinglong3-system
type: Opaque
stringData:
  postgres-worker-ingress-url: postgresql://ql3_worker_ingress:REDACTED@postgres-rw.example.internal:5432/qinglong
  postgres-tls-servername: postgres-rw.example.internal
  postgres-ca.crt: |
    -----BEGIN CERTIFICATE-----
    REPLACE_WITH_OPERATOR_CA_BUNDLE
    -----END CERTIFICATE-----
  worker-credential-pepper: REPLACE_WITH_DISTINCT_CANONICAL_32_BYTE_BASE64URL
  artifact-s3-bucket: REPLACE_WITH_PRIVATE_IMMUTABLE_ARTIFACT_BUCKET
  artifact-s3-region: REPLACE_WITH_BUCKET_REGION
  artifact-s3-encryption: s3
  tls.key: |
    -----BEGIN PRIVATE KEY-----
    REPLACE_WITH_WORKER_INGRESS_SERVER_PRIVATE_KEY
    -----END PRIVATE KEY-----
  tls.crt: |
    -----BEGIN CERTIFICATE-----
    REPLACE_WITH_WORKER_INGRESS_SERVER_CERTIFICATE_CHAIN
    -----END CERTIFICATE-----
  client-ca.crt: |
    -----BEGIN CERTIFICATE-----
    REPLACE_WITH_WORKER_CLIENT_CA_BUNDLE
    -----END CERTIFICATE-----
```

The CloudNativePG overlay deletes the generic Worker DSN and instead consumes
the operator-managed `ql3-postgres-worker-ingress-auth` Secret plus
`ql3-postgres-ca`. The Worker listener never receives the runtime database
password. Artifact access may use a workload identity; for an S3-compatible
private endpoint, add the optional endpoint/path-style and access-key fields
shown by the deployment manifest through a private overlay. Plain HTTP requires
the explicit `artifact-s3-allow-insecure: "true"` opt-in.

## Optional Remote Worker Secret values

The base enables the `mounted-files` provider but projects a separate optional
Secret named `ql3-cluster-worker-values`. If that Secret or an exact entry is
absent, Secret-bearing Runs fail closed; non-Secret Runs and the Worker
listener remain available. The control Pod does not receive Kubernetes API
credentials and never reads plaintext values from PostgreSQL or environment
variables.

Each data key is lowercase
`SHA-256(canonical qlsecret:v1 SecretRef)` and each value is the exact UTF-8
Secret material. Hashing is only a path-safe identifier, not encryption. Given
the immutable SecretRef already emitted by the QingLong management plane,
prepare the projection without placing plaintext in a manifest:

```bash
secret_ref='qlsecret:v1:REPLACE_WITH_CANONICAL_REFERENCE'
file_key="$(printf '%s' "${secret_ref}" | shasum -a 256 | awk '{print $1}')"

kubectl -n qinglong3-system create secret generic ql3-cluster-worker-values \
  --from-file="${file_key}=/private/path/to/exact-secret-value" \
  --dry-run=client -o yaml |
  kubectl apply -f -
```

Do not append a newline unless it is part of the intended value. A single
value is limited to 16 KiB and one delivery to 64 KiB. Projected target files
must be regular, non-executable, non-world-accessible and no more permissive
than `0440`; the committed Pod uses `fsGroup: 10001`, a read-only mount and
`defaultMode: 0440`.

The provider reopens the exact hashed files only after the Run/Attempt/Lease,
Worker Session, execution digest and SecretRef set pass the database authority
transaction. It accepts Kubernetes atomic-writer symlinks only when the
resolved target remains inside the mounted root. Updating the Secret therefore
rotates current references without a watcher, timer, cache, process restart or
Kubernetes API permission. Version-pinned SecretRefs use a different hash and
remain immutable by policy; retain their files until referenced Run/Artifact
retention has completed.

Create a distinct migration Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ql3-cluster-migration
  namespace: qinglong3-system
type: Opaque
stringData:
  postgres-migration-url: postgresql://ql3_migration:REDACTED@postgres-rw.example.internal:5432/qinglong
  postgres-tls-servername: postgres-rw.example.internal
  postgres-ca.crt: |
    -----BEGIN CERTIFICATE-----
    REPLACE_WITH_OPERATOR_CA_BUNDLE
    -----END CERTIFICATE-----
```

Run the reviewed migration stream explicitly before the Deployment:

```bash
kubectl create -k deploy/kubernetes/ql3-cluster/operations
kubectl -n qinglong3-system get jobs
kubectl -n qinglong3-system logs job/ql3-cluster-migration
```

The operation uses a fixed name, one connection, `backoffLimit: 0` and a
separate Secret and CA projection. It is deliberately not part of the
continuously reconciled runtime base. A completed log must contain
`migration_completed`; only then should the runtime Deployment be applied. The
runtime role must subsequently pass the exact schema/readiness contract.
Delete the completed Job before explicitly creating it again.

## Deploy

Copy `overlays/example` to a private overlay and replace the image with an
immutable registry digest. Apply the Namespace and ServiceAccount before the
one-shot migration Job, then apply the complete runtime overlay:

```bash
kubectl apply -k deploy/kubernetes/ql3-cluster/overlays/local
kubectl -n qinglong3-system rollout status deployment/ql3-cluster-control
```

The base deliberately requires the two replicas to run on different nodes.
Single-node development clusters need a private overlay that changes the
required anti-affinity to preferred; that relaxed topology is not production HA
evidence.

## Security and availability boundary

- Pods run as UID/GID 10001 with a read-only root filesystem, dropped
  capabilities, `RuntimeDefault` seccomp and no Kubernetes API token.
- `/livez` reports process liveness; `/readyz` opens only after schema
  readiness, recovery and lifecycles converge. A new activation first rejects
  standby or transaction-read-only endpoints by requiring
  `pg_is_in_recovery() = false` and `transaction_read_only = off`; PostgreSQL
  availability loss withdraws admission without turning liveness into
  readiness.
- `SIGTERM` withdraws admission, drains bounded lifecycles and closes the Pool
  before the process exits. A timed-out drain exits unsuccessfully.
- The Service is cluster-internal HTTP. Any northbound API exposure must use a
  reviewed TLS ingress/gateway and an explicit NetworkPolicy appropriate to
  that cluster.
- The committed tag is an incubation placeholder. Production overlays must pin
  an image digest.

The bounded private-CA binding, CloudNativePG manifests, local arm64 container
inventory and local amd64/arm64 attested OCI layout are implemented, but this
baseline is not evidence for a completed protected GHCR release, a
registry-verifiable Cosign signature/GitHub attestation, an installed
PostgreSQL operator with a real TLS/failover/CA-rotation drill, infrastructure
STONITH, Kubernetes control-plane failover, a real Pod network partition,
backup restore or raw PostgreSQL packet loss. Those remain separate release
gates.

Plugin Package active-pointer publication has a separate opt-in Kind 1.32.8
gate:

```sh
QL3_PLUGIN_PACKAGE_KUBERNETES_LIVE=1 \
  QL3_KIND_BIN=/absolute/path/to/kind \
  QL3_KUBECTL_BIN=/absolute/path/to/kubectl \
  pnpm test:plugin-package-kubernetes-live:ql3
```

It builds and loads the independent `cluster-admin` image into an exact,
disposable Kind cluster, then runs two restricted Pods with the production
ConfigMap-only RBAC shape. Both attempt the same `resourceVersion`; exactly one
replacement wins. The gate also injects response loss only after the API has
confirmed the initial create, requires inspect/replay without a second create,
and proves list/delete/Secret/cross-namespace requests return 403. It is not a
PostgreSQL/OCI end-to-end recovery, raw-wire loss or control-plane HA claim.

The full recovery ordering has a separate opt-in three-node Kind gate:

```sh
QL3_PLUGIN_PACKAGE_RECOVERY_E2E_LIVE=1 \
  QL3_KIND_BIN=/absolute/path/to/kind \
  QL3_KUBECTL_BIN=/absolute/path/to/kubectl \
  pnpm test:plugin-package-recovery-e2e:ql3
```

It rebuilds the current `cluster-control` and `cluster-admin` images, loads the
digest-verified PostgreSQL 18.4 image, and runs these controller-owned phases
sequentially:

```text
PostgreSQL ready
  -> reviewed migration Job Complete (18 migrations, capability v17)
  -> durable queued PackageLock persisted by the admin Repository
  -> HTTPS OCI manifest/config/referrer/signature/bundle resolution
  -> production Plugin Package recovery Job Complete
  -> deployment controller binds the recovery Job evidence
  -> two cluster-control replicas Ready on different worker nodes
```

The gate also requires one active-pointer ConfigMap, four durable installation
mutations ending in `active`, zero recoverable heads, exact ConfigMap
get/create/update-only RBAC, and PostgreSQL denial when the runtime role tries
to read Plugin Package administration tables. A failed Job is detected
immediately; the script refuses to reuse a pre-existing cluster and deletes only
the exact cluster it created.

This is end-to-end workload and ordering evidence, not a production security
shortcut. The isolated PostgreSQL fixture explicitly disables TLS while the
committed production manifests remain `verify-full`. The authenticated HTTPS
OCI fixture implements the immutable Distribution GET/referrers surface
consumed by the resolver, but it is not a production Registry
storage/authentication implementation. Production PostgreSQL TLS, production
Registry storage/authentication and Kubernetes control-plane HA remain
independent release gates.
