# Isolated Prompt output lost-key recovery verifier

This caller-driven Job verifies one externally recovered Prompt output key in a
separate `qinglong3-recovery` namespace. It is not part of the default Cluster
Kustomization and does not provision, wrap, unwrap, export or reactivate key
material.

The deployment authority must prepare a private read-only PVC named
`ql3-prompt-output-external-recovery-workspace`. Copy `command.example.json` to
`command.json` and provide exactly the referenced files:

- one provider-neutral atomic custody bundle containing the signed content-free
  receipt and its digest-bound wrapped blob;
- the 32-byte material produced by the external KMS/HSM unwrap ceremony;
- the exact durable `keyId/materialProof/catalogDigest` fact from an isolated
  PostgreSQL/CNPG restore;
- the immutable encrypted Artifact from that same restore generation;
- the pinned custody signing public key;
- an unexpired recovery authorization signed by two different strong Users,
  plus both pinned approver public keys.

The verifier never accepts the receipt and wrapped blob as separate files, so a
partial copy or cross-generation substitution cannot create a mixed recovery
input. Every workspace file must be a non-symlink, single-link, read-only
regular file.
Private files must not be readable by `other`; the recovered material must be
exactly 32 bytes. Provisioning the PVC, copying backup evidence and invoking the
KMS/HSM are deployment-authority responsibilities outside this Job.

The repository includes a concrete Vault Transit adapter without making Vault
part of the QingLong runtime. Copy `vault-transit-wrap-command.example.json`
or `vault-transit-unwrap-command.example.json` into a private authority,
replace every placeholder, make commands/keys/token/material read-only, and run:

```sh
pnpm custody:vault-transit:ql3 -- wrap --command-file /owner-private/wrap.json
pnpm custody:vault-transit:ql3 -- unwrap --command-file /owner-private/unwrap.json
```

Production mode requires HTTPS plus an explicit CA file and reads the Vault
token only from a private file. Wrap creates one no-replace `0400`
provider-neutral bundle; replay verifies that bundle without another Vault
call. Unwrap verifies the signing authority, bundle digest,
provider/key-version authority and exact material proof before creating one
no-replace `0400` recovered material file. Copy that bundle unchanged into the
verifier workspace as `custody-bundle.json`. The Vault token, endpoint and key
name are never embedded in the bundle. Do not run either Vault command in the
tokenless, deny-all verifier Job.

The opt-in live gate uses the exact reviewed Vault image digest and removes its
random container and private workspace on both success and failure:

```sh
QL3_RUN_VAULT_TRANSIT_LIVE=true pnpm test:vault-transit-custody-live:ql3
```

That gate proves the actual Vault 1.21.4 Transit API over TLS 1.3 with an
explicit private CA. It initializes a persistent file barrier with three seal
shares and a threshold of two, wraps the key, replaces the entire non-root
read-only-rootfs container, observes the persisted server sealed, re-unseals
it, verifies the Transit key survived and then unwraps the bundle. A different
CA is rejected before API access. This remains a single-host file-storage
fixture, not HA integrated storage, HSM auto-unseal, enterprise PKI/external
IdP or CNPG restore evidence.

The separate opt-in PostgreSQL composition gate proves that the exact durable
key fact and encrypted Artifact can cross a real logical backup boundary before
the offline verifier receives them:

```sh
QL3_RUN_POSTGRES_BACKUP_RECOVERY_LIVE=true \
  pnpm test:postgres-backup-prompt-output-recovery-live:ql3
```

It uses the digest-pinned PostgreSQL 18 image on a random loopback-only port,
runs the complete QL3 core and AI migration streams, and persists a canonical
Package publication plus Prompt admission/start/completion/finalization,
encrypted Artifact and key-rotation record through production repositories. It
then creates a custom-format backup, removes the whole source container and
anonymous volume, restores into a different container/volume, reopens the
production Artifact and rotation repositories, and only then exports the
restored fact and Artifact to the existing two-User verifier. The restored
lineage includes the exact 52 core and 16 AI migration histories and one row for
each required publication and Prompt chain fact. The gate removes both random
containers, their anonymous volumes and its private directory on success or
failure. This is full production-schema logical PostgreSQL backup composition
evidence; it is not CloudNativePG Barman WAL/PITR or an external IdP ceremony.

The Pod has no Role or RoleBinding, disables ServiceAccount token projection,
mounts the PVC read-only and is selected by an ingress/egress deny-all
NetworkPolicy. It receives no PostgreSQL URL, Kubernetes credential, cloud
credential, KMS endpoint or HSM session. Successful stdout is a content-free,
authorization-bound recovery proof. Failure output contains only stable error
metadata. The CLI wipes its owned recovered and wrapped buffers before exit.

This verifies recoverability only. It does not authorize plaintext export,
production Secret mutation, retirement reversal, keyring reconstruction or
bulk re-encryption. Those operations require separate policy and evidence.
