# `@qinglong/worker-runtime`

This private workspace package incubates the QingLong 3.0 headless `worker`
Profile without importing the legacy root application or cluster-control
packages.

Its first responsibility is Worker transport identity:

- generate a local P-256 private key and PKCS#10 CSR without contacting a CA;
- validate an externally issued TLS client certificate against the pending key,
  expected trust anchors, validity window and client-auth EKU;
- atomically install bounded `0600` private-key and certificate files;
- coordinate explicit renewal attempts with persisted, bounded exponential
  backoff and a fail-closed expiry state;
- install no watcher, signal handler, timer, database connection or network
  client by itself.

External CA adapters and the final `ql-worker` composition root own transport,
credential enrollment and scheduling. Certificate CN/SAN remains descriptive
metadata and never replaces the independent `ql3w` Worker credential, Session
generation or Run Lease fence.

The explicit `./remote-offer-delivery` subpath now owns the default-off Remote
Worker delivery boundary:

- a versioned, capability-free offer response validator;
- one durable pending claim with bounded full-jitter retry across restarts;
- a private single-owner atomic file inbox that commits before claim cleanup;
- a bounded TLS 1.3 mTLS HTTPS client carrying the independent `ql3w`
  credential;
- one revision-fenced execution inbox authority and an injected-port Processor
  that persists starting/spawn/started/running barriers without a second
  journal.

The Processor can call an explicitly injected Executor and activation client,
but this package does not construct either capability, create a polling timer,
or import cluster-control/PostgreSQL authority. Ambiguous spawn outcomes enter
recovery and are never reported as a definite start failure. The package root
intentionally does not export this subpath so certificate-only steady state
remains light.

The `./lease-control` and `./execution-control` subpaths extend the same
default-off boundary without adding a package or background timer:

- one exact, path-bound lease-control exchange over the shared mTLS Agent;
- a stable credential fingerprint pool key, so erased request-local TLS
  buffers cannot strand a later request in the Agent queue;
- receipt-first renewal and cancellation/timeout projection using the full
  Session/Run/Attempt/Offer/Lease fence;
- inbox CAS of the next Lease version before exact durable-handle stop;
- distinct durable evidence for conclusive and unverified local lease loss;
- caller-driven bounded supervision before each headless Pull;
- POSIX timeout launch only after starting ACK returns a database-owned durable
  deadline.

The explicit `./production` subpath now supplies the concrete execution-plane
composition while remaining default-off:

- one journal owner, one shared mTLS client/Agent and the reviewed
  Offer/Activation/Secret/Artifact/Completion/Lease adapters;
- one Secret-before-Artifact materializer, file-log allocator, reviewed POSIX
  Executor, receipt store and durable process controller;
- bounded startup reconciliation before the first Pull and one Profile-owned,
  non-overlapping `unref` cadence;
- two-stage shutdown that aborts Pull but retains the journal owner until the
  outer Session is durably draining and all local records are settled.

The exact `./session-transport` and timer-free `./session-lifecycle` subpaths
provide path-bound register/heartbeat/transition v1 contracts over that same
client. The default-off `./product` composition root now joins them to the
execution plane:

- startup owns and scans the journal before registering a Session;
- advertised slots come only from the same journal, durable pending Pull claim
  and bounded concurrency budget;
- one coalesced Profile cadence drives heartbeat and execution supervision;
- shutdown proves execution drain, durable zero-capacity Session state,
  settled records and offline transition before releasing owner and Agent.

The outer deployment still owns certificate and `ql3w` credential
enrollment/recovery, config, retention and process shutdown policy. Disabled
mode reads none of those authorities and creates no timer, socket, process or
database connection. Edge defaults keep pages, logs and the single cadence
narrow; Node defaults raise bounded capacity, and larger nodes scale by Worker
instance rather than by per-Run timers.

Deployments that already possess an atomically published `ql3w` token can use
the explicit `./production-credentials` subpath. It reloads the certificate
store active generation, trust anchors and one private token file for every
request, revalidates their authority, and lets the shared client erase returned
PEM buffers after copying. This supports certificate/token rotation without a
watcher, cache, second Agent or timer. It is intentionally not an issuer or
credential-recovery client; remote issue/rotate/revoke and secret-delivery
acknowledgement remain deployment gates.

The shared transport exposes only a non-success HTTP status class. Session
401/403 responses suspend Pull immediately, 409 fences the Session, and
transient failures preserve the last observed lease. A rotated token may
recover heartbeat on that same Session; the runtime never creates a replacement
Session automatically.
