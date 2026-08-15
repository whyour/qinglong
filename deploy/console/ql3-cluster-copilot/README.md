# Cluster read-only field Console

This Console is an operator-workstation process, not a resident QingLong
service. Native execution serves digest-bound assets on an ephemeral
`127.0.0.1` port and forwards only a fixed vocabulary of Run, Task, Workflow
and Copilot reads to existing Cluster APIs. It never accepts a browser-provided
URL or method. Do not deploy it as a Kubernetes workload, Ingress, shared LAN
listener, Edge component or legacy 2.x Web route.

Use `ql3-cluster-admin` from the same independently verified Admin release as
the Cluster deployment. D-328 also supports the image-carried
`docker-loopback.sh`: it uses an explicit container-only listener but publishes
the same port exclusively on host `127.0.0.1`. Arbitrary `0.0.0.0`, host
networking and LAN publication remain forbidden.

## Verify the distribution

The multi-architecture `qinglong3-cluster-admin@sha256:…` OCI image is the
distribution artifact. It already carries the exact launcher, examples and
this document under `/opt/qinglong/share/ql3-copilot-console/`; there is no
second Node archive or package dependency graph to trust.

From the exact reviewed source tag, run `verify-release.sh` with the immutable
image digest, repository, 40-hex source revision and full tag ref. The verifier
requires `cosign` and authenticated `gh`, then independently checks the keyless
release-workflow identity, SLSA provenance, CycloneDX SBOM and digest-bound OS
vulnerability evidence. It rejects tags and mutable image references.

```sh
deploy/console/ql3-cluster-copilot/verify-release.sh \
  ghcr.io/replace-owner/qinglong3-cluster-admin@sha256:REPLACE_64_HEX \
  replace-owner/qinglong \
  REPLACE_40_HEX_SOURCE_REVISION \
  refs/tags/v3.0.0-alpha.0
```

After verification, pull that exact digest. The signature covers the embedded
host launcher and templates as part of the image filesystem. Operators may
either use the launcher from the matching reviewed tag or extract its exact
image-carried copy with `docker create` plus `docker cp` before execution.

## Prepare private authority

Create an absolute canonical directory with mode `0700`. For native execution
it is owned by the current operator; for the image-carried launcher it and all
files are owned by UID/GID `10001:10001`. Copy `client-config.example.json` to
`client.json`, install the reviewed
Cluster API CA as `ca.pem`, and install a separately issued `ql3c_` Project API
credential as `credential`. Give the credential only `run.read`, `task.read`
and `artifact.read`; `run.read` covers Run and Workflow observations, while
`task.read` covers Task list/detail and `artifact.read` covers an explicitly
requested Copilot output. The Console has no route for Run/Workflow start,
diagnosis creation or cancellation even if a wider credential is supplied.

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

The page exposes thirteen exact operations: Copilot `inspect|output`; Run
list/detail/events/steps; Task list/detail; and Workflow list plus Workflow Run
list/detail/events/steps. List responses use 32-row pages and offer an explicit
next-page read only when the upstream cursor says more data exists. There is no
automatic cascade from a list to details, steps or events, so each authority
read remains visible and intentional.

## Export a redacted evidence bundle

After at least one successful read, **Export redacted bundle** creates one
UTF-8 JSON file entirely in browser memory. Export performs zero BFF or Cluster
requests and includes only the evidence already visible in the current page.
The ledger retains at most the newest sixteen entries and 8 MiB of canonical
raw facts; reaching either limit removes the oldest visible and in-memory
entry. The generated file is capped at 512 KiB.

The fixed allowlist keeps operation, local observation time, reviewed status
enums, bounded numeric/boolean facts, pagination state and typed aliases.
Project, Run, Task, Workflow, Package, Step, Artifact, request and digest values
become per-bundle aliases without an exported mapping. Free text, names,
paths/URLs, commands, inputs/outputs, environment, errors/messages, credentials,
tokens, authorization, unknown fields and Copilot model text are omitted. A
canonical SHA-256 for each omitted raw fact allows a later local comparison
without embedding that fact.

The top-level SHA-256 detects changes to the redacted JSON, but it is not a
server signature, durable audit, origin attestation or action authority. Review
the file before sharing it. Generation uses no upload, clipboard/share API,
browser storage, worker, timer or service-side temporary file. **Clear page**
removes the current in-memory ledger without sending a request.

## Run the verified image

Create a dedicated Docker network whose egress is restricted by the host
firewall to DNS and the exact Cluster API destination. Copy
`host-environment.example.json` values into the launcher environment, replacing
the image with the verified digest and selecting one unused host port. The
launcher rejects `bridge|default|host|none`, mutable tags, noncanonical private
roots, ports outside `1024..65535` and unknown resource classes.

| Resource class | Memory | CPU | PIDs | Console reads |
| --- | ---: | ---: | ---: | ---: |
| `compact` | 192 MiB | 0.25 | 32 | 2, no queue |
| `standard` | 512 MiB | 1 | 64 | 2, no queue |

Validate private authority and the upstream unauthenticated TLS 1.3 readiness
route without opening or publishing a listener:

```sh
deploy/console/ql3-cluster-copilot/docker-loopback.sh check
```

Then start the foreground session:

```sh
deploy/console/ql3-cluster-copilot/docker-loopback.sh serve
```

The launcher fixes non-root UID, read-only root, no capabilities,
no-new-privileges, bounded memory/CPU/PIDs, an 8 MiB noexec tmpfs, one read-only
private mount and `--pull never`. `serve` alone adds
`--publish 127.0.0.1:<port>:<port>/tcp`; `check` publishes nothing. The
container listener is reachable only through this reviewed publication and
continues to require the 256-bit browser session token plus exact Host/Origin.
