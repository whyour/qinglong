# QingLong 3.0 Worker Credential Management Client Operation

This operation lets an authorized operator workstation submit one reviewed
Worker credential management command through the in-cluster TLS endpoint. The
workstation drives Kubernetes object creation; the request itself runs in one
short-lived Pod that has no Kubernetes API token or RBAC.

It is not a controller, scheduler, sidecar or credential executor. It can call
only the management transport (`plan`, `propose`, `decide` or `inspect`) and
cannot consume an approval, request a ServiceAccount token or write a Worker
Secret.

## Preconditions

- the opt-in `ql3-worker-credential-management` Deployment has two Ready Pods;
- the manager certificate covers
  `ql3-worker-credential-management.qinglong3-system.svc`;
- a reviewed CA bundle is available outside the repository;
- a short-lived client certificate and matching private key issued by the
  manager's reviewed client CA are available outside the repository and are
  absent from the current CRL;
- the external identity provider has minted a short-lived, strong-User
  assertion for the exact operator and command, with
  `aud=qinglong3-worker-credential-management`,
  `typ=ql3-worker-credential-management+jwt` and
  `ql3_purpose=worker-credential-management`;
- the production Admin image digest has been independently verified.

Do not use a Project API bearer, browser session, Worker credential or
Kubernetes ServiceAccount token as the assertion. A Plugin Package management
assertion is also invalid even when it uses the same issuer and signing key;
there is no legacy-purpose compatibility window in QingLong 3.0.

## Prepare one private command

Copy
`deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client/config.example.yaml`
to a private directory that is excluded from source control. Replace every
placeholder. The four input objects have fixed names and are immutable:

- `ql3-worker-credential-management-request` contains only `client.json` and
  the one reviewed `command.json`;
- `ql3-worker-credential-management-client-trust` contains the reviewed manager
  CA certificate;
- `ql3-worker-credential-management-assertion` contains one short-lived strong
  User assertion.
- `ql3-worker-credential-management-client-identity` contains only the
  short-lived client certificate chain and matching private key. It is a
  separate possession factor and does not replace the User assertion.

`client.json` must reference `/tmp/ca.crt`, `/tmp/client.crt` and
`/tmp/client.key`. The production client verifies the certificate/private-key
match before opening a connection. Do not reuse the manager server key, an
assertion-signing key or a Worker execution certificate.

The example command is read-only `worker-credential.inspect`. For a mutation,
produce a new command through the approved plan → propose → decide ceremony;
never edit an existing immutable input object in place. Run only one instance
of this fixed-name operation at a time.

Create a private Kustomize overlay that references the repository operation and
replaces the all-zero image digest with the reviewed production digest:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - /absolute/path/to/qinglong/deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client

images:
  - name: registry.example.com/qinglong/qinglong3-cluster-admin
    newName: registry.example.com/qinglong/qinglong3-cluster-admin
    digest: sha256:REPLACE_WITH_REVIEWED_PRODUCTION_DIGEST
```

Render and inspect both private inputs and the Job before creation. The checked
in all-zero digest is deliberately unusable and must never be replaced by a
mutable tag.

## Execute and observe

```bash
kubectl create -f /absolute/private/worker-credential-command-inputs.yaml
kubectl create -k /absolute/private/worker-credential-client-overlay

kubectl -n qinglong3-system wait \
  --for=condition=Complete \
  job/ql3-worker-credential-management-client \
  --timeout=150s

kubectl -n qinglong3-system logs \
  job/ql3-worker-credential-management-client \
  --container=client
```

The init container may retry only the authenticated TLS 1.3 `/readyz` probe so
that DNS and NetworkPolicy can converge. The main container invokes the
production client exactly once. `backoffLimit: 0` and `restartPolicy: Never`
prevent Kubernetes from replaying an ambiguous business request.

If the init container fails, no business request was sent. If the main
container starts and its outcome is unavailable, inspect the durable plan,
approval and audit facts before replaying the exact semantic command. Do not
mint new idempotency identities or assume that a missing client response means
rollback.

After evidence has been retained, remove the completed operation and its
short-lived inputs before preparing the next command:

```bash
kubectl -n qinglong3-system delete \
  job/ql3-worker-credential-management-client \
  networkpolicy/ql3-worker-credential-management-client \
  serviceaccount/ql3-worker-credential-management-client

kubectl -n qinglong3-system delete \
  configmap/ql3-worker-credential-management-request \
  configmap/ql3-worker-credential-management-client-trust \
  secret/ql3-worker-credential-management-assertion \
  secret/ql3-worker-credential-management-client-identity
```

## Fixed security and resource envelope

- no ServiceAccount token, RBAC, environment-sourced credential or host access;
- deny-all ingress; egress only to kube-system DNS and same-namespace manager
  Pods on TCP 8444;
- request, assertion, client identity, trust and memory-backed scratch are
  separate projections;
- non-root UID/GID 10001, read-only root filesystem, RuntimeDefault seccomp and
  all Linux capabilities dropped;
- effective Pod request is 25 millicores/48 MiB and the limit is 250
  millicores/128 MiB because init and main containers run sequentially;
- no steady-state CPU, memory, connection, timer or process cost after the Job
  exits.

The repository gate is:

```bash
pnpm test:worker-management-kubernetes-live:ql3
```

It loads the checked-in ServiceAccount, NetworkPolicy and Job into a disposable
three-node K3s cluster, substitutes only the locally built production image,
and proves successful init/main exit, zero client restarts, immutable inputs,
no projected ServiceAccount token, health probes without client identity,
business-route rejection without a certificate, CRL rejection after a
zero-unavailable rollout, acceptance of the replacement certificate and the
full two-manager availability and OIDC identity-rotation matrix.

For a real external-identity separation-of-duty report that intentionally stops
before approval consumption or credential delivery, use
[`ql3-worker-credential-management-live-ceremony.md`](./ql3-worker-credential-management-live-ceremony.md).
The same operation guide includes the independent, short-lived read-only
PostgreSQL durable-audit collector required after the ceremony.
