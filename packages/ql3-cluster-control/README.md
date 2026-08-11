# `@qinglong/cluster-control`

This private workspace package is the composition root for the QingLong 3.0
`cluster-control` profile artifact.

It owns the readiness-first database lifecycle and exposes both the proven
runtime pool and a public-contract PostgreSQL RunRepository to a caller-supplied
stack factory. It depends only on public `@qinglong/runtime-core` and
`@qinglong/cluster-postgres/runtime` exports, so the resident control plane does
not load executable migration DDL. It must never deep-import the legacy root
`back/**` tree.

Public subpath exports now separate responsibilities:

- `@qinglong/cluster-control/application` owns the probe listener, activation,
  admission drain, runtime stack, Pool and listener shutdown order;
- `@qinglong/cluster-control/availability` provides the one-way, timer-free
  `ready -> unavailable` fence used by the PostgreSQL Pool error path;
- `@qinglong/cluster-control/http` provides bounded `/livez`, `/readyz` and
  fail-closed `/api/v3` admission transport;
- `@qinglong/cluster-control/config` parses the Profile gate before reading the
  runtime database credential/API credential pepper and defaults PostgreSQL to
  verified TLS;
- `@qinglong/cluster-control/api-credential` validates the versioned `ql3c`
  bearer format and authenticates a stable subject with a constant-time,
  peppered digest comparison;
- `@qinglong/cluster-control/admission` resolves a route, authenticates a stable
  principal, evaluates Policy and records the security decision before the HTTP
  adapter is allowed to read the bounded request body;
- `@qinglong/cluster-control/routes` compiles an immutable, bounded and
  non-overlapping route table whose operation, permission, Project path
  parameter and query allowlist are fixed at startup.
- `@qinglong/cluster-control/run-routes` defines the first reviewed business
  route: a Project-scoped `run.get` point query that returns only an explicit
  low-sensitive DTO and masks cross-Project existence.
- `@qinglong/cluster-control/production` is the only reviewed production route
  composition, fixes the current allowlist to `run.get` and `run.cancel`, and
  atomically derives the runtime Pool plus its availability fence from one
  enabled configuration so deployments cannot miswire those authorities;
- `@qinglong/cluster-control/s3-artifact-store` is a separately lazy-loaded,
  cluster-only immutable Artifact adapter; neither the package root nor the
  production API entrypoint loads the AWS SDK;
- `@qinglong/cluster-control/worker-ingress` owns the separately gated TLS 1.3
  mutual-TLS listener and exposes explicit secure-context reload without
  acquiring database adapter or CA-signing authority;
- `@qinglong/cluster-control/worker-ingress-config` loads bounded server
  identity, 1–16 client CA certificates and an optional CRL after the Profile
  gate, builds only the dedicated Worker HTTP/Pool options, and validates the
  immutable S3 Artifact binding;
- `@qinglong/cluster-control/worker-runtime-port` constructs the frozen
  in-process offer/ACK/Artifact/completion/lease capability boundary without
  exposing the runtime Pool;
- `@qinglong/cluster-control/worker-ingress-production` combines that port with
  the independent Worker credential/Session/attestation/audit Pool.

The cluster assembly now supplies real PostgreSQL API Credential, Project
Policy and write-only Security Audit repositories, plus a bounded recovery
candidate source. After the caller's recovery reports safe convergence, the
bootstrap independently verifies PostgreSQL has no orphaned or expired-lease
Run/Attempt candidate; a false-safe summary cannot open admission. Admission accepts only a
route resolver produced by the reviewed registry factory; a caller cannot
silently replace it with an ad-hoc resolver. The tested vertical path is HTTP
bearer authentication → fenced Project Policy → durable low-sensitive audit →
bounded body/handler.

The production application registers the reviewed `run.get` and `run.cancel`
routes through one static allowlist and, when explicitly enabled, starts the
independent 5801 mTLS Worker listener after readiness/recovery. Runtime
Run/Attempt/Lease mutation stays behind the injected capability port;
`ql3_worker_ingress` receives no such database grant. Artifact S3 support is
loaded only on that enabled path, so disabled Cluster and all local Profiles do
not load its provider.

Identity/credential administration remains in the separate short-lived
cluster-admin authority, and the resident HTTP surfaces retain bounded
authentication overload shields. Remaining incubation gaps include Cluster
Secret material provider/rotation, Remote Worker expiry/retry production
lifecycle, audit retention/export/alerting and real multi-Pod
operator/proxy/STONITH capacity evidence. The generic admission pipeline must
not be wired to an allow-all authenticator or Policy in production.
