# Cluster Copilot MCP stdio container

This is an explicit host-side deployment for the bounded Cluster Copilot MCP.
It is not a Kubernetes Deployment or Service: stdio must be owned by the MCP
host that launches the process. A resident Pod without that parent session
would be unreachable while still retaining a credential and image attack
surface.

The launcher uses the existing independently released Cluster Admin image and
its default `ql3-cluster-admin` entrypoint. It selects the reviewed
`copilot-mcp` subcommand, never overrides the entrypoint and never mounts a
Kubernetes token, database credential, Docker socket or writable directory.

## Prepare the private projection

Create an absolute canonical directory owned by UID/GID `10001:10001`, mode
`0700`. Copy `mcp-config.example.json` to `mcp.json` and
`client-config.example.json` to `client.json`; install the reviewed API CA as
`ca.pem` and the separately issued `ql3c_` Project API credential as
`credential`. All four files must be regular, non-symlink, UID 10001-owned,
canonical files with mode `0600`. Never put the credential value in the MCP
host config, argv, environment or image.

Replace the endpoint, DNS server name and CA. The client uses TLS 1.3, does not
use a client certificate, proxy, redirect or ambient CA, and rereads
`credential` for every Tool call.

## Select resources and egress

Create a dedicated Docker network whose host firewall permits only DNS and the
reviewed Cluster API destination. The launcher rejects `bridge`, `default`,
`host`, `none` and an implicit network, but Docker network naming alone is not
an egress allowlist.

| Resource class | Memory | CPU | PIDs | Maximum configured concurrency |
| --- | ---: | ---: | ---: | ---: |
| `compact` | 192 MiB | 0.25 | 32 | 1 |
| `standard` | 512 MiB | 1 | 64 | 4 |
| `dense` | 1 GiB | 2 | 96 | 16 |

The launcher passes a second concurrency ceiling to the process. Startup and
preflight fail closed if `mcp.json` requests more concurrency than its resource
class. There is no queue, retry, poller, watcher or resident health timer.

Export only the immutable image digest, private directory path, dedicated
network name and resource class, then validate before registering the host:

```sh
deploy/mcp/ql3-cluster-copilot/docker-stdio.sh check
```

The check validates all mounted path/credential authority and makes one
unauthenticated `GET /readyz`. Its JSON contains no endpoint, path, credential
or cluster identity. A not-ready response exits 69; invalid local authority or
transport failure emits only a low-sensitive failure fact.

Copy `mcp-host.example.json` into the external MCP host's private
configuration, replace its launcher path, image digest, private root and
network, and map its `command`/`args`/`env` fields to the host's equivalent
stdio process adapter. `serve` runs Docker attached to stdin/stdout with a
read-only root filesystem, no capabilities, no-new-privileges, a fixed
non-root UID, bounded memory/CPU/PIDs and `--pull never`.

Do not compose this directory into Edge/Standalone, `cluster-control`, the
Cluster AI Pod or any shared Kubernetes operations Kustomization. Small router
profiles continue to use the separately bounded Local MCP artifact only when
explicitly selected; otherwise they carry no MCP dependency at all.
