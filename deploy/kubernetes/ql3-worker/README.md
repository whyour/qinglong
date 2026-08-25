# QingLong 3.0 Worker deployment baseline

The Worker is an outbound-only, headless process. It opens one shared TLS 1.3
client authority to the Cluster Worker ingress and owns one local execution
journal. It does not expose an HTTP Service, database connection or Kubernetes
API credential.

The committed base intentionally references, but does not create,
`ql3-worker-config`, `ql3-worker-identity` or the mutable credential target.
The separate `credential-bootstrap` asset creates an empty, labelled
`ql3-worker-credential` exactly once so the delivery authority needs only
exact-name `get` and `update`, never broad Secret creation in the Worker
namespace. Copy the ConfigMap and TLS identity examples into a private overlay,
replace every placeholder and use a separately issued Worker ID, certificate,
`ql3w` token and PVC for every deployed Worker. Do not put the `ql3w` token in
the TLS identity Secret.

Never scale this Deployment above one replica. A replica is not a stateless
copy: the Worker ID, Session, credential, journal, logs, receipts and running
POSIX processes form one authority. Horizontal capacity is added by deploying
another independently named Worker with another identity and volume.

Build the image from the repository root:

```bash
node scripts/ql3-worker-image-lock.cjs
docker build \
  --file deploy/containers/ql3-worker/Dockerfile \
  --tag qinglong3-worker:3.0.0-alpha.2 \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  .
```

Production rollout must take the Worker `@sha256:` reference from the same
verified `cluster` or `all` release set as control, control-ai and admin. A
version/source tag or a successful control image alone is not Worker release
authority. Render the private Worker overlay, run the offline deployment-lock
post-renderer with `--required-images=worker`, audit the locked manifest, and
apply only that locked output. See
[`docs/operations/ql3-release-set-deployment.md`](../../../docs/operations/ql3-release-set-deployment.md).

The builder and runtime dependency roots have separate npm v3 locks generated
from the reviewed workspace `pnpm-lock.yaml`. The runtime image contains only
`runtime-core`, `local-process`, `worker-runtime` and their 24 external runtime
packages. The bundled durable launcher is copied explicitly and made
executable; no QingLong 2.x server, UI, SQLite or PostgreSQL package is present.

Each Worker identity needs two namespaces: one Worker namespace containing only
that identity's Deployment, PVC, ConfigMap, TLS Secret and credential target,
and a separate staging namespace containing only immutable credential delivery
stages. Never deploy either into the shared `qinglong3-system` namespace. A
single Worker namespace is not sufficient because the stage authority must not
be able to list the TLS private-key Secret.

Before applying, create both namespaces and materialize the private
ConfigMap/TLS Secret. The committed names are `qinglong3-worker` and
`qinglong3-worker-credential-staging`; a private overlay must replace both for
every independently named Worker. It must also replace
`qinglong.io/worker-identity-generation` with a stable, non-secret generation
identifier derived by the operator's release process. Then apply either the
edge base or the node resource overlay and the credential-admin RBAC. Render
the private credential-bootstrap overlay and submit it with create-only
semantics before the first delivery:

```bash
kubectl kustomize deploy/kubernetes/ql3-worker/base > /private/workstation/path/worker-rendered.yaml
# or render deploy/kubernetes/ql3-worker/overlays/node
# Materialize and audit worker-locked.yaml using the release-set procedure,
# then apply only the locked output:
kubectl apply -f /private/workstation/path/worker-locked.yaml
kubectl apply -k deploy/kubernetes/ql3-worker/credential-admin
kubectl kustomize deploy/kubernetes/ql3-worker/credential-bootstrap \
  | kubectl create -f -
```

An `AlreadyExists` response is a safety stop, not an instruction to apply,
replace or delete the target. The normal base/GitOps reconciliation set must
exclude this mutable Secret; if an external reconciler imports it, configure
that reconciler to ignore the target data, labels and annotations owned by
credential delivery. Never use server-side apply to continuously reconcile the
bootstrap manifest.

The first Pod remains pending until credential delivery populates the prepared
`ql3-worker-credential`. Publication is not complete after only replacing that
Secret. `WorkerCredentialKubernetesDeliveryAdapter` stages immutable Secrets in
the separate staging namespace, then reads the exact
single-replica `Recreate` Deployment, verifies that it projects the dedicated
Secret, and replaces the PodTemplate with delivery ID, credential ID,
generation, token digest and publication digest annotations under the same
`resourceVersion` fence. A crash between Secret and Deployment updates is
replayed from the durable delivery ledger; the adapter returns success only
after the PodTemplate converges. It owns no watcher, timer, controller loop or
Worker-side Kubernetes credential.

Run a delivery through
`createWorkerCredentialKubernetesKubeConfigTokenRequestSession`, using an
external OIDC/client-certificate identity mapped to the dedicated
`qinglong:worker-credential-operators` Kubernetes group. That group can only
create the `serviceaccounts/token` subresource for the exact delivery
ServiceAccount; it cannot use the delivery RBAC itself. The session requests a
TokenRequest credential, not an automatically mounted or persisted
ServiceAccount token:

```bash
kubectl -n qinglong3-worker-credential-staging create token \
  ql3-worker-credential-admin --duration=10m
```

The command above is an operator troubleshooting equivalent, not the product
execution path: it prints the bearer token and therefore must never be used by
automation. The production session receives only the issuer kubeconfig,
constructs the delivery client in memory, validates the issued JWT subject and
at-most-600-second lifetime, runs 8 required-allow and 20 required-deny
SelfSubjectAccessReview checks before mutation, and invalidates the restricted
client in `finally`. It never returns the token or adapter. The ServiceAccount
has `automountServiceAccountToken: false`. In the staging namespace it can only
`get/list/create/delete` Secrets.
In the Worker namespace it can only `get/update` the exact prepared credential
Secret and exact Worker Deployment. It cannot read the TLS Secret, list Worker
Secrets, access Pods, create a target Secret, patch/delete workloads, mint a
replacement token or inspect cluster-scoped resources. Stage `create` and
`list` cannot safely be narrowed by `resourceNames`, which is why the empty
staging namespace is a required isolation boundary.

The issuer kubeconfig remains external operator authority and must use strong,
short-lived authentication; do not bind the token-issuer Role to the delivery
ServiceAccount, Worker Pod, control Pod or a broad system group. Approval and
durable product command binding are separate management-plane gates and are not
implied by possession of this Kubernetes role.

The projected TLS Secret, credential Secret and ConfigMap are not consumed directly. Kubernetes
projects them through symlinks and group-readable modes, while the Worker
credential boundary requires direct files, a `0700` parent and `0400` private
material. The non-root init container creates its own `private/` subdirectory
inside the fsGroup-writable tmpfs, copies the bounded inputs there and
initializes `0700` recovery directories on the PVC before the main process
starts. It never relies on changing the root-owned mount-point mode.

CA/key/certificate rotation uses the same `Recreate` boundary but remains an
explicit deployment operation: update `ql3-worker-identity`, advance
`qinglong.io/worker-identity-generation` in the private overlay and wait for the
old Pod to terminate before accepting the replacement Session. Never reuse the
credential adapter as TLS-key authority; separating the Secrets prevents its
least-privilege API client from reading the Worker private key.

The PVC is mandatory. Replacing it with `emptyDir` can erase the only evidence
needed to decide whether a process was spawned or completed after a restart.
The Pod uses `Recreate` and a 360-second termination grace so the node profile's
five-minute drain can keep heartbeating and settle completion evidence. An
incomplete drain deliberately does not exit successfully.

The process entrypoint itself retains one ref'ed lifecycle handle while it
waits for SIGINT/SIGTERM. A pending JavaScript Promise alone does not keep Node
alive; removing this handle makes an otherwise active Worker exit with code 0
and puts an `Always`-restart Pod into `CrashLoopBackOff`. The handle is cleared
with signal authority after proof-bearing stop, does not poll Kubernetes and
does not replace the application's single execution cadence.

There is no synthetic Kubernetes readiness or liveness probe. A running PID
does not prove that startup reconciliation completed or that the Worker Session
is schedulable, and an automatic liveness kill can destroy the only drain
owner. Operational readiness is the current durable Worker Session observed
through the Cluster control plane.

The manual `ql3-worker-kubernetes-rollout-live` workflow and
`qinglong/worker-kubernetes-rollout-live-contract@v2` prove the current Worker
image through three distinct Pod/Session generations, per-Session heartbeat,
credential and mTLS identity Recreate, startup reconciliation, shared PVC and
graceful offline transition. This single-node K3s/local-path evidence is not a
claim about multi-node CSI detach/attach or physical node loss.

For routers or other small non-Kubernetes devices, run the same
`ql3-worker` binary with `QL3_WORKER_CAPACITY_PROFILE=edge`, one concurrent run,
the 2-second cadence defaults and private persistent directories. Do not install
the Cluster PostgreSQL, control-plane, admin or UI closure on that device.
