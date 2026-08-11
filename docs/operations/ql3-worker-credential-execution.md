# QingLong 3.0 caller-driven Worker credential execution

This operation consumes one already approved Worker credential action. It is a
short-lived Kubernetes `Job`, not a scheduler, controller or rotation loop.
The management Deployment never receives this Job's PostgreSQL credential,
pepper or Kubernetes issuer token.

## Preconditions

- PostgreSQL is migrated through `pg-0050` and the dedicated
  `ql3_worker_credential_executor` role is ready.
- The Worker `credential-admin` overlay is installed. Its delivery
  ServiceAccount has the reviewed 8-allow/20-deny RBAC matrix.
- Two distinct strong Users created and approved the exact immutable plan.
- The caller has the resulting action, approval, consumption, dispatch and
  audit IDs without any credential token.
- The independently verified cluster-admin image digest is available.

Copy
`deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/config.example.yaml`
to a private per-dispatch overlay. Replace every placeholder. Keep
`command.json` at schema version 1 with exactly these six fields:

```json
{"schemaVersion":1,"actionRef":"…","approvalRequestId":"…","consumptionId":"…","dispatchId":"…","auditEventId":"…"}
```

Create the pepper through a Secret manager. It must be a distinct canonical
32-byte base64url value and must not appear in the command, argv, logs, Git or
the management Deployment. Treat the immutable command ConfigMap as
per-dispatch input; do not rewrite and reuse it for a different approval.

## Private network and image overlay

The committed base deliberately permits only DNS. The CloudNativePG overlay
adds only the exact `ql3-postgres` Pods on TCP 5432. Copy
`api-server-egress-patch.example.yaml` into the private overlay and replace its
TEST-NET address and port with the exact Kubernetes API destination observed by
Pods under the deployed CNI. Some CNIs enforce policy before Service DNAT and
others after it; verify the enforced destination rather than assuming the
`kubernetes.default` ClusterIP is sufficient. Never use `0.0.0.0/0`, an empty
egress peer, or a namespace-wide API destination.

The private Kustomization must also replace the all-zero
`qinglong3-cluster-admin` digest with the independently verified digest. Keep
the Job `backoffLimit` at zero: a caller inspects durable execution state before
explicitly deciding whether to retry the same command.

Render and audit before creating anything:

```bash
pnpm audit:cluster-deployment:ql3
kubectl kustomize /absolute/path/to/private-worker-executor-overlay >/tmp/ql3-worker-executor.yaml
```

Review the rendered file for exactly one `Job`, no `CronJob` or `Deployment`,
the executor-only PostgreSQL Secret, a 600-second projected ServiceAccount
token and the exact TokenRequest RoleBinding. Then create and observe it:

```bash
kubectl create -k /absolute/path/to/private-worker-executor-overlay
kubectl -n qinglong3-system wait \
  --for=condition=Complete job/ql3-worker-credential-executor \
  --timeout=10m
kubectl -n qinglong3-system logs job/ql3-worker-credential-executor
```

Successful stdout contains only low-sensitive execution and delivery status.
It never contains the issued Worker token. On failure, inspect the durable
approval dispatch and execution receipt before recreating the same exact Job;
do not generate a new command identity or broaden RBAC to force progress.

## Live evidence

The `test:worker-kubernetes-rollout-live:ql3` gate runs current-source
cluster-admin, cluster-control and Worker images in K3s `v1.34.3+k3s1`
against digest-bound PostgreSQL 18.4. Its first
caller-driven Job completed a third credential rotation with
`deliveryStatus=published` and `tokenRequestUsed=true`. A second independent
Job replayed the exact same command and completed with
`deliveryStatus=existing` and `tokenRequestUsed=false`. The durable database
facts converged to four plans, consumed approvals, dispatches, successful
executions, credentials and published deliveries plus sixteen management
security audit events. Three host-side fresh execution/exact-replay pairs
perform exactly nine authorization rechecks; the separate Job keeps its own
authorization boundary.

The product phase then composes the real Cluster Worker ingress and production
Worker over TLS 1.3 mutual authentication. Credential generation 4 and a new
client identity each force a `Recreate` replacement on the same RWO PVC. The
three distinct Worker Sessions must each persist `online`, at least one
heartbeat audit, `draining` and `offline`; their generations must increase
strictly. The final scale-to-zero must complete graceful drain before the
360-second Kubernetes termination grace expires.

That gate also demonstrates why private overlays must account for the active
CNI enforcement point: K3s-in-Docker required exact egress to both the
`kubernetes.default` Service `/32:443` and its post-DNAT API backend `/32:6443`.
This is evidence for exact destination discovery, not permission to copy those
fixture addresses into another cluster or widen the destination CIDR.

Run this destructive fixture only with explicit opt-in and a new private report
path. The parent directory must already exist, must not be a symlink and should
be mode `0700`:

```bash
QL3_WORKER_KUBERNETES_ROLLOUT_LIVE=1 \
QL3_KUBECTL_BIN=/absolute/path/to/kubectl \
pnpm test:worker-kubernetes-rollout-live:ql3 \
  --report=/absolute/private/worker-kubernetes-report.json

pnpm audit:worker-kubernetes-rollout-live:ql3 \
  --report=/absolute/private/worker-kubernetes-report.json
```

The producer refuses to overwrite a report and writes it with mode `0600`.
The auditor is process-independent, rejects non-exact schemas and secret
material, and must return `compatible=true`. The corresponding GitHub Actions
workflow is manual-only; it does not add K3s, PostgreSQL or Cluster packages to
an Edge/Standalone deployment.

After retaining the required audit evidence, delete the per-dispatch command
ConfigMap and pepper Secret according to the deployment retention policy. The
Job TTL removes only the finished Job; it does not remove those caller-owned
inputs.
