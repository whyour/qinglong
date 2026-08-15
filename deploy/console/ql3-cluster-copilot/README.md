# Cluster Copilot read-only Console

This Console is an operator-workstation process, not a resident QingLong
service. It serves digest-bound assets on an ephemeral `127.0.0.1` port and
forwards only `inspect` and explicit `output` reads to the existing Cluster
Copilot API. Do not deploy it as a Kubernetes workload, Ingress, shared LAN
listener, Edge component or legacy 2.x Web route.

Use `ql3-cluster-admin` from the same independently verified Admin release as
the Cluster deployment. The Console intentionally runs directly on the trusted
operator workstation. A container port mapping is not a supported substitute:
the process binds container loopback and must not be widened to `0.0.0.0`.

## Prepare private authority

Create an absolute canonical directory owned by the current operator with mode
`0700`. Copy `client-config.example.json` to `client.json`, install the reviewed
Cluster API CA as `ca.pem`, and install a separately issued `ql3c_` Project API
credential as `credential`. Give the credential only `run.read` and
`artifact.read`; the Console has no route for diagnosis creation or
cancellation even if a wider credential is supplied.

Create an independent 256-bit browser session key without placing its value in
argv or an environment variable:

```sh
install -d -m 0700 /absolute/private/ql3-copilot-console
umask 077
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > /absolute/private/ql3-copilot-console/session
chmod 0600 /absolute/private/ql3-copilot-console/client.json /absolute/private/ql3-copilot-console/ca.pem /absolute/private/ql3-copilot-console/credential /absolute/private/ql3-copilot-console/session
```

Every file must be a current-owner, non-symlink, canonical regular file. The
session file contains exactly 43 base64url characters and no newline. It is a
browser-to-loopback secret only; it cannot authenticate to the Cluster API.
The `ql3c_` credential remains in the BFF process and is reread for every
upstream request so file rotation takes effect without browser disclosure.

## Check and start

Run the preflight first:

```sh
ql3-cluster-admin copilot-console --check \
  --config /absolute/private/ql3-copilot-console/client.json \
  --credential /absolute/private/ql3-copilot-console/credential \
  --session /absolute/private/ql3-copilot-console/session
```

It validates all three private authorities and performs one unauthenticated
TLS 1.3 `GET /readyz`. It does not open the Console listener or reveal paths,
endpoint, credential, Project or Cluster identity.

Start a session with an ephemeral port:

```sh
ql3-cluster-admin copilot-console \
  --config /absolute/private/ql3-copilot-console/client.json \
  --credential /absolute/private/ql3-copilot-console/credential \
  --session /absolute/private/ql3-copilot-console/session \
  --port=0
```

Open only the exact `http://127.0.0.1:<port>` origin printed by the process,
then enter the session key from the private file. The browser keeps it only in
page memory; reloading locks the page. Stop the process with `SIGINT` or
`SIGTERM`, then remove or rotate the session file.

The BFF accepts at most two concurrent reads and sixteen connections, rejects
a third request without queueing, caps request bodies at 4 KiB and responses at
approximately 2 MiB, disables cache/cookies/frames/workers, and never polls.
Model text is rendered as plain text and remains untrusted advice. These limits
keep the workstation surface bounded, but this Cluster-only product is still
excluded from small router Edge/Standalone artifacts.
