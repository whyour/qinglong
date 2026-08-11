# Caller-driven Cluster Prompt output key rotation

This operation activates one externally staged 32-byte key while retaining all
existing keys for historical decryption. It never provisions the target Secret
and is not part of the default Cluster Kustomization.

Before creating the Job:

1. Read the current target Secret UID, active key ID, generation and catalog
   digest through the reviewed deployment ceremony.
2. Ask the deployment Secret manager or KMS boundary to create the immutable
   `ql3-prompt-output-key-rotation-material` Secret in `qinglong3-system`. It
   must contain exactly one 32-byte `material.bin` data item. Do not commit it,
   use `stringData`, or grant this Job API access to that staging Secret.
3. Copy `command.example.yaml` into private configuration and replace every
   placeholder. The new key ID must be unique. Keep the fixed staged-material
   path unchanged.
4. Patch `network-policy.yaml` with the real Kubernetes API server `/32` and
   TCP port by using `api-server-egress-patch.example.yaml`; never widen it to
   a public or cluster-wide CIDR. Replace the deny-canary placeholder only with
   a separately proven reachable in-cluster canary.
5. Pin the independently verified Cluster Admin image digest, apply the private
   command ConfigMap and staged Secret, then create the resources in `base`.

The process first appends a content-free PostgreSQL preparation through the
dedicated `ql3_ai_maintenance` role, then performs the target Secret CAS, and
finally appends the completion. Reusing the same command and staged material
after any process or response-loss window converges from those durable facts.
The CloudNativePG overlay binds only the writer endpoint, maintenance identity,
private CA and exact database Pod egress.

The ServiceAccount can get/update only `ql3-prompt-output-keyring` and create
SelfSubjectAccessReview requests. The Pod and ServiceAccount disable automatic
tokens; a tokenless init container proves API allow plus deny-canary blocking
before the main container receives a 600-second projected token. The material
and command are separate read-only single-file `subPath` mounts. A lost update
response is resolved by rereading the target and comparing the exact staged
material proof; blind Job retries remain disabled.

Delete the completed Job, command ConfigMap and staged material Secret after
retaining content-free evidence. First target-Secret provision, KMS wrapping
and lost-key recovery remain separate release gates.

The opt-in product evidence gate is:

```sh
QL3_PROMPT_OUTPUT_KEY_ROTATION_KUBERNETES_LIVE=1 \
QL3_CNPG_OPERATOR_MANIFEST_FILE=/owner-private/cloudnative-pg-1.30.0.yaml \
pnpm test:prompt-output-key-rotation-kubernetes-live:ql3
```

It creates a random three-node K3s/Flannel fixture, runs CloudNativePG with
three PostgreSQL instances, applies the main and AI migrations, executes the
rotation twice, and proves the same tokenless runtime Pod reloads generation
1→2 while retaining historical Artifact decrypt. It also requires one target
Secret resourceVersion change, one content-free preparation/completion pair,
exact RBAC/egress, a read-only `0440` staging projection and zero fixture/image
residue. This single-host, dynamic local-path fixture is not production CSI,
control-plane HA, infrastructure STONITH, KMS wrapping or HSM evidence.
