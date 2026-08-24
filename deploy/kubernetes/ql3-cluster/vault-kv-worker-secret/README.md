# Vault KV v2 Worker Secret custody

This overlay replaces the base `mounted-files` value projection with direct,
TLS 1.3 Vault KV v2 resolution. The control Pods mount only the private Vault
CA and one short-lived read token; Secret values and opaque Legacy Env bundles
remain in Vault and are fetched only after the durable Worker delivery authority
has been validated.

The exact Vault policy is read-only:

```hcl
path "worker-secrets/data/values/production/*" {
  capabilities = ["read"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
```

Issue an orphan, non-renewable service token with only that policy and a TTL no
greater than 15 minutes. Rotate the projected `token` atomically before expiry;
the adapter rereads and revalidates it for every authorized resolution. A Vault
Agent or external Secret operator may own this projection, but must not project
the actual Worker Secret values.

Store each value at
`worker-secrets/data/values/production/<sha256(canonical SecretRef)>` with this
exact KV payload:

```json
{
  "schemaVersion": 1,
  "secretRefDigest": "<same 64-hex path key>",
  "encoding": "base64",
  "value": "<canonical base64 bytes>"
}
```

Create the two private Kubernetes Secret objects from
`credentials.example.yaml` through the deployment authority, then render:

```sh
kubectl kustomize deploy/kubernetes/ql3-cluster/vault-kv-worker-secret
```

The overlay intentionally does not create a NetworkPolicy because the base
control-plane deployment has no universal egress policy and external Vault
topologies differ. If the namespace is default-deny, explicitly allow DNS,
PostgreSQL, the artifact store and TCP 8200 only to the reviewed Vault identity.
