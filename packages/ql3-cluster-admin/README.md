# `@qinglong/cluster-admin`

This private QingLong 3.0 package owns explicit cluster operations and the
bounded Cluster Copilot MCP and Console product surfaces.
Database/Kubernetes administration remains short-lived and requires distinct
purpose-bound authority. The MCP subpath has only the remote API client; the
Console is a loopback-only read BFF serving digest-bound static assets. Neither
opens database or Kubernetes authority, enters the legacy 2.x Web application,
or resides in `cluster-control`.

The Console accepts only `inspect` and explicit `output` reads. Its Cluster
API credential stays in a canonical owner-private file and is reread for each
upstream request; browser JavaScript receives only a separate session token
which cannot call Cluster APIs. It binds `127.0.0.1`, enforces exact
Host/Origin, no-store responses and a closed CSP, renders model text only via
`textContent`, and keeps diagnose/cancel, polling, cache, WebSocket,
ServiceWorker and legacy session authority absent.

The reviewed operator-workstation setup, private-file ceremony, preflight and
session lifecycle are documented in
`deploy/console/ql3-cluster-copilot/README.md`. Do not expose the Console
through a container port mapping, Kubernetes workload or shared network.

The admin role can append Identity/API Credential mutations and their security
audit in one serializable transaction, and can perform bounded read-only audit
queries. It cannot read or mutate Run, Project or RoleBinding data, cannot
update/delete credential history, and cannot delete audit events.

Prompt output lifecycle work remains outside the resident control plane. The
explicit `prompt-output-gc-process` runs one bounded retention page, while
`prompt-output-key-retirement-process` coordinates one durable PostgreSQL
prepare/material-delete/complete operation through an injected material
authority. The latter intentionally does not select or dynamically load a KMS:
each deployment must bind a reviewed KMS/HSM adapter, and the process returns
only content-free identities, digests, status, and database time.

Credential issue/rotation returns the bearer token only for a newly inserted
mutation. Exact mutation replay returns `token: null`; a caller that loses the
one-time response must rotate again instead of recovering secret material from
storage. Replay equality covers caller-controlled semantics (actor,
authentication/request/mutation identity, subject, version, operation and
explicit absolute `notBeforeAtMs`/`expiresAtMs`), while generated secret/digest
and server timestamps are excluded. A collision in any semantic field fails
closed.

Production Worker credential rollout must use the explicit
`@qinglong/cluster-admin/worker-credential-delivery` subpath instead of exposing
that one-time response. It stages a new credential ID before one atomic
credential/mutation/audit/delivery commit, appends publication acknowledgement,
and never returns the token. The current slice is intentionally short-lived and
timer-free. Authenticated Session observation is appended in the Session
transaction; a bounded PostgreSQL-timed recovery page can resume publication,
wait for observation, and atomically revoke the previous credential while
appending delivery v4. The explicit
`@qinglong/cluster-admin/worker-credential-file-delivery` subpath supplies a
bounded POSIX implementation for Docker bind mounts, systemd deployments and
controlled single-writer volumes: private no-replace stages, generation-fenced
atomic token replacement, durable directory synchronization and bounded stage
enumeration. Capability v15 also provides a database-authorized orphan cleanup:
the inventory coordinator must append an exact immutable discard tombstone
before deleting a stage, while credential commit and discard authorization share
one PostgreSQL advisory transaction lock so exactly one can win. Authorization
and unfinished cleanup are recovered through separate bounded pages without a
resident timer. The explicit
`@qinglong/cluster-admin/worker-credential-kubernetes-delivery` subpath provides
the multi-writer deployment adapter without adding another package: immutable
per-delivery staging Secrets, target updates fenced by the resourceVersion from
the preceding GET, exact replay after 409, and UID + resourceVersion deletion
preconditions. It uses the exact-pinned official Kubernetes client through a
narrow injected Secret API, owns no watcher/timer/cache, and fails closed when
the stage inventory exceeds 128 objects; cleanup pages remain capped at 64.
A real k3s 1.34 API-server test with a dedicated ServiceAccount proves the
get/list/create/update/delete-only RBAC matrix, concurrent update single winner,
and preconditioned delete. Kubernetes HA/control-plane failover, stale-lock
repair for the POSIX adapter, PostgreSQL 18/failover evidence, and product-facing
administration remain gated.

Plugin Package recovery is exposed only through
`plugin-package-oci-stage`, `plugin-package-recovery` and
`plugin-package-recovery-process`. The process is the entrypoint for a
short-lived recovery Job; it opens one `ql3_package_executor` Pool, proves the
exact executor schema/role
readiness, serially converges a bounded recovery cycle, closes PostgreSQL and
exits. It is not imported by `cluster-control`.

The OCI stage authority implements the OCI Distribution API without another
workspace package. A PackageLock binds the OCI manifest digest in its locator
and independently binds the single bundle layer digest and byte length. The
resolver accepts only an explicit registry allowlist, HTTPS, no redirects and
no ambient credential provider. It validates the package manifest/config,
retrieves exactly one lock-annotated OCI referrer, verifies its Ed25519
publisher signature, and streams the bundle through the common inspector.
The deterministic evidence can be re-resolved after process restart; a bounded
64-entry cache only avoids fetching the same evidence twice during one Job.

The production Kustomize operation gives its dedicated ServiceAccount only
namespace-scoped ConfigMap `get/create/update`. It receives neither Secret API
access nor runtime/migration database credentials. A dedicated Kind 1.32.8
live gate runs two non-root, read-only-rootfs admin-image Pods with real
projected ServiceAccount tokens. It proves one API-confirmed create response
loss converges through durable inspect without a second create, and that two
processes attempting the same `resourceVersion` produce one winner and one
conflict. ConfigMap list/delete, Secret access and cross-namespace reads are
all denied. The response-loss injection is at the client boundary after the
API confirms create; it is not raw-wire packet loss or Kubernetes
control-plane HA evidence. Private registry authentication and package
resource-generation consumers remain gated.

Cluster Package management authentication is exposed only through the
`plugin-package-identity-assertion` and
`plugin-package-management-transport` subpaths. The identity verifier accepts
only a dedicated compact JWS purpose with one canonical HTTPS issuer, one exact
audience, an explicitly reviewed public-key set and deployment-specific
ACR-plus-required-AMR mappings to `multi_factor` or `hardware`. It supports
Ed25519, P-256 and bounded RSA public keys through Node 24 built-in crypto and
adds no dependency. Raw assertions and `jti` values do not enter management
requests or results. The shared verifier/file implementation is now composed
by two authority-specific processes: Plugin Package management and Worker
credential management. The Worker process is available only through
`worker-credential-management-process`; it opens the dedicated
`worker-credential-manager` PostgreSQL role, validates the v49 role contract,
pins keyset generations under authority `worker-credential-management`, uses
database-clock durable quota before management state reads, then exposes only
the fixed TLS 1.3 Worker management route. It does not import Worker delivery,
TokenRequest or executor authority. Its disabled gate opens no files, listener
or database, and the Kubernetes operation remains explicit opt-in.

The three-node K3s management gate runs two required-anti-affinity replicas and
the production TLS 1.3 client against each exact Pod. It proves shared durable
quota (8 admitted/8 limited), cross-Pod semantic replay, identity generation
overlap/revocation/rollback, and database-failure readiness withdrawal followed
by fresh-Pod-only recovery. Plan replay equality covers caller-controlled plan
semantics; server-authored plan times and their derived digests return the
original stored plan, while target or requester drift remains a conflict.

Approved Worker delivery execution is exposed separately through
`worker-credential-executor-process` and `ql3-worker-credential-execute`. The
process accepts one exact non-secret command file, a private canonical 32-byte
pepper file, the dedicated executor PostgreSQL role and one in-cluster issuer
session. It confirms the exact TokenRequest authorization before and during
execution, delegates the 8-allow/20-deny delivery proof to the restricted
session, clears issuer client credentials and exits after one result. The
Kubernetes operation is a caller-created `Job`, never a `CronJob` or resident
controller; its base NetworkPolicy remains DNS-only until a private overlay
adds the exact API-server and database destinations.
A real K3s `v1.34.3+k3s1` gate runs this production image and process: the first
Job publishes generation 3 with one 600-second TokenRequest, while a second
independent Job replays the exact command as `existing` without another token
request. Both use the executor-only one-connection PostgreSQL role,
`backoffLimit=0`, no automounted token and exact API/PostgreSQL egress.
