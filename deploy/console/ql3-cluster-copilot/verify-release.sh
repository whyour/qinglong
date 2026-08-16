#!/bin/sh

set -eu

usage() {
  printf '%s\n' 'Usage: verify-release.sh IMAGE@sha256:DIGEST OWNER/REPO SOURCE_REVISION refs/tags/v3.VERSION' >&2
  exit 64
}

fail() {
  printf '%s\n' '{"schemaVersion":1,"component":"qinglong3-cluster-admin-release-verifier","event":"verification_failed"}' >&2
  exit 78
}

[ "$#" -eq 4 ] || usage
image=$1
repository=$2
source_revision=$3
source_ref=$4

printf '%s' "$repository" | grep -Eq '^[a-z0-9][a-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' || fail
owner=${repository%%/*}
printf '%s' "$image" | grep -Eq "^ghcr.io/$owner/qinglong3-cluster-admin@sha256:[0-9a-f]{64}$" || fail
printf '%s' "$source_revision" | grep -Eq '^[0-9a-f]{40}$' || fail
printf '%s' "$source_ref" | grep -Eq '^refs/tags/v3\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$' || fail
command -v cosign >/dev/null 2>&1 || fail
command -v gh >/dev/null 2>&1 || fail

workflow="$repository/.github/workflows/ql3-image-release.yml"
certificate_identity="https://github.com/$workflow@$source_ref"

cosign verify \
  --certificate-identity "$certificate_identity" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$image" >/dev/null || fail

verify_attestation() {
  predicate_type=$1
  if [ -n "$predicate_type" ]; then
    set -- --predicate-type "$predicate_type"
  else
    set --
  fi
  gh attestation verify "oci://$image" \
    --repo "$repository" \
    --signer-workflow "$workflow" \
    --source-digest "$source_revision" \
    --source-ref "$source_ref" \
    "$@" \
    --deny-self-hosted-runners \
    --bundle-from-oci >/dev/null || fail
}

verify_attestation ''
verify_attestation https://cyclonedx.org/bom
verify_attestation https://qinglong.dev/attestations/image-os-vulnerability/v1
verify_attestation https://qinglong.dev/attestations/release-candidate-contract/v1

printf '%s\n' '{"schemaVersion":1,"component":"qinglong3-cluster-admin-release-verifier","signature":true,"provenance":true,"sbom":true,"osVulnerabilityEvidence":true,"releaseCandidateContract":true,"compatible":true}'
