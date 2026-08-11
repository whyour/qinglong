# Optional Cluster AI durable Prompt output

This component opts the existing Cluster AI runtime into encrypted, durable
Prompt output. Apply it only together with `../cluster-ai`; the default Cluster
and default Cluster AI profiles remain live-output-only.

The runtime receives only a read-only `0440` projection of
`ql3-prompt-output-keyring/keyring.json`. It does not receive a ServiceAccount
token, Kubernetes API authority, or permission to provision, rotate, or retire
keys. The projected-keyring adapter reopens the manifest for each operation, so
Kubernetes atomic projection updates become visible without a process restart.

Before applying it:

1. Provision the namespaced `ql3-prompt-output-keyring` Secret through the
   deployment platform or Secret manager. Do not commit key material or a
   deployable Secret manifest to this repository.
2. Store the canonical
   `qinglong/plugin-package-prompt-output-keyring@v1` document under the exact
   `keyring.json` data key. Keep the active key and bounded decrypt-only history
   in that one document.
3. Apply both components from a private overlay and pin the independent Cluster
   AI image digest, as shown by
   `../../overlays/cluster-ai-prompt-output-example/kustomization.yaml`.
4. Use the reviewed management operation for retirement. Provisioning and
   active-key rotation remain deployment-plane responsibilities; the runtime
   must never be granted Secret mutation authority.

The Secret must remain non-optional. A missing, malformed, writable, escaped,
or rotating-during-read keyring fails startup or the affected operation closed.
