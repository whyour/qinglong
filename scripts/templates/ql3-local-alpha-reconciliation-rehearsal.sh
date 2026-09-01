#!/bin/sh

set -eu

OPERATOR_IMAGE='@@OPERATOR_IMAGE@@'
OPERATOR_ID='@@OPERATOR_ID@@'
ARCHITECTURE='@@ARCHITECTURE@@'
SOURCE_REVISION='@@SOURCE_REVISION@@'
ARCHIVE='@@ARCHIVE@@'
VARIANT='@@VARIANT@@'

PLAN_ID='019f8680-143d-4000-8000-000000000201'
REVIEW_ID='019f8680-143d-4000-8000-000000000301'
APPLICATION_ID='019f8680-143d-4000-8000-000000000401'
AUTOMATION_ID='019f8680-143d-4000-8000-000000000461'
AUTOMATION_DECISION_ID='019f8680-143d-7000-8000-000000000471'
AUTOMATION_MUTATION_ID='019f8680-143d-4000-8000-000000000481'
SECRET_CONFIG_ID='019f8680-143d-4000-8000-000000000491'
SECRET_CONFIG_DECISION_ID='019f8680-143d-7000-8000-0000000004a1'
SECRET_CONFIG_MUTATION_ID='019f8680-143d-4000-8000-0000000004b1'
RUN_HISTORY_PRESERVATION_ID='019f8680-143d-4000-8000-0000000004c1'
COMPLETION_ID='019f8680-143d-4000-8000-0000000004d1'

fail() {
  printf '%s\n' "QingLong Local Alpha reconciliation rehearsal failed: $*" >&2
  exit 1
}

phase() {
  printf '%s\n' "QingLong Local Alpha reconciliation phase: $1" >&2
}

usage() {
  printf '%s\n' \
    'usage: sh reconciliation-rehearsal.sh prepare edge|standalone /absolute/rehearsal-root /absolute/capture-root /absolute/new/reconciliation-root <legacy-timezone|none>' \
    '       sh reconciliation-rehearsal.sh review edge|standalone /absolute/rehearsal-root /absolute/capture-root /absolute/reconciliation-root /absolute/review-decisions.ndjson' \
    '       sh reconciliation-rehearsal.sh apply-rollback edge|standalone /absolute/rehearsal-root /absolute/capture-root /absolute/reconciliation-root /absolute/automation-decisions.ndjson /absolute/legacy-root' \
    '       sh reconciliation-rehearsal.sh apply-plan edge|standalone /absolute/rehearsal-root /absolute/capture-root /absolute/reconciliation-root /absolute/automation-decisions.ndjson /absolute/review-decisions.ndjson /absolute/legacy-root' \
    '       sh reconciliation-rehearsal.sh complete edge|standalone /absolute/rehearsal-root /absolute/capture-root /absolute/reconciliation-root /absolute/secret-config-decisions.ndjson /absolute/review-decisions.ndjson /absolute/legacy-root' >&2
  exit 2
}

safe_absolute_path() {
  case "$1" in
    /|*[!A-Za-z0-9_./@-]*|*'/../'*|*'/./'*|*'/..'|*'/.'|*'//'*|*/)
      return 1
      ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}

valid_digest() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; *) return 0 ;; esac
}

extract_digest() {
  result_file=$1
  field=$2
  value=$(sed -n "s/^.*\"$field\":\"\([0-9a-f][0-9a-f]*\)\".*$/\1/p" "$result_file")
  valid_digest "$value" || fail "$field is missing or invalid in $result_file"
  printf '%s' "$value"
}

extract_unsigned() {
  result_file=$1
  field=$2
  value=$(sed -n "s/^.*\"$field\":\([0-9][0-9]*\).*$/\1/p" "$result_file")
  case "$value" in ''|*[!0-9]*) fail "$field is missing or invalid in $result_file" ;; esac
  printf '%s' "$value"
}

extract_capture_id() {
  result_file=$1
  value=$(sed -n 's/^.*"captureId":"\([0-9a-f-][0-9a-f-]*\)".*$/\1/p' "$result_file")
  case "$value" in
    ????????-????-4???-[89ab]???-????????????) printf '%s' "$value" ;;
    *) fail "captureId is missing or invalid in $result_file" ;;
  esac
}

non_overlapping() {
  left=$1
  right=$2
  [ "$left" != "$right" ] || return 1
  case "$left/" in "$right"/*) return 1 ;; esac
  case "$right/" in "$left"/*) return 1 ;; esac
  return 0
}

canonical_directory() {
  selected=$1
  label=$2
  safe_absolute_path "$selected" || fail "$label is not a safe canonical absolute path"
  [ -d "$selected" ] || fail "$label does not exist"
  [ ! -L "$selected" ] || fail "$label must not be a symbolic link"
  [ "$(realpath "$selected")" = "$selected" ] || fail "$label is not canonical"
}

private_decision_file() {
  decision_file=$1
  decision_label=$2
  safe_absolute_path "$decision_file" || fail "$decision_label is not a safe canonical absolute path"
  [ -f "$decision_file" ] || fail "$decision_label does not exist"
  [ ! -L "$decision_file" ] || fail "$decision_label must not be a symbolic link"
  [ "$(realpath "$decision_file")" = "$decision_file" ] || fail "$decision_label is not canonical"
  size=$(stat -c %s "$decision_file")
  [ "$size" -ge 2 ] && [ "$size" -le 4194304 ] || fail "$decision_label is empty or too large"
  file_mode=$(stat -c %a "$decision_file")
  [ "$file_mode" = 400 ] || [ "$file_mode" = 600 ] || fail "$decision_label must have mode 0400 or 0600"
  decision_parent=${decision_file%/*}
  [ -n "$decision_parent" ] || decision_parent=/
  canonical_directory "$decision_parent" "$decision_label parent"
  [ "$(stat -c %a "$decision_parent")" = 700 ] || fail "$decision_label parent must have mode 0700"
  extra_entry=$(find "$decision_parent" -mindepth 1 -maxdepth 1 ! -path "$decision_file" -print -quit)
  [ -z "$extra_entry" ] || fail "$decision_label parent must contain only the selected decision file"
  for authority_root in "$rehearsal_root" "$capture_root" "$reconciliation_root"; do
    non_overlapping "$decision_file" "$authority_root" || fail "$decision_label must be outside all authority roots"
    non_overlapping "$decision_parent" "$authority_root" || fail "$decision_label parent must be outside all authority roots"
  done
}

[ "$#" -ge 1 ] || usage
mode=$1
case "$mode" in
  prepare|review) [ "$#" -eq 6 ] || usage ;;
  apply-rollback) [ "$#" -eq 7 ] || usage ;;
  apply-plan|complete) [ "$#" -eq 8 ] || usage ;;
  *) usage ;;
esac
profile=$2
rehearsal_root=$3
capture_root=$4
reconciliation_root=$5
phase_input=$6
secondary_input=
legacy_root=
case "$mode" in
  apply-rollback) legacy_root=$7 ;;
  apply-plan|complete) secondary_input=$7; legacy_root=$8 ;;
esac

case "$profile" in edge|standalone) ;; *) usage ;; esac
case "$VARIANT" in headless|console) ;; *) fail 'embedded Trial Kit variant is invalid' ;; esac
[ "$(uname -s)" = Linux ] || fail 'reconciliation rehearsal requires a Linux Docker host'
for tool in docker sha256sum grep sed stat date realpath find mv rm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
canonical_directory "$rehearsal_root" 'rehearsal root'
canonical_directory "$capture_root" 'capture root'
safe_absolute_path "$reconciliation_root" || fail 'reconciliation root is not a safe canonical absolute path'
non_overlapping "$rehearsal_root" "$capture_root" || fail 'rehearsal and capture roots overlap'
non_overlapping "$rehearsal_root" "$reconciliation_root" || fail 'rehearsal and reconciliation roots overlap'
non_overlapping "$capture_root" "$reconciliation_root" || fail 'capture and reconciliation roots overlap'
if [ -n "$legacy_root" ]; then
  canonical_directory "$legacy_root" 'legacy root'
  for authority_root in "$rehearsal_root" "$capture_root" "$reconciliation_root"; do
    non_overlapping "$legacy_root" "$authority_root" || fail 'legacy root overlaps an authority root'
  done
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
(CDPATH= cd -- "$script_dir" && sha256sum --check SHA256SUMS)
docker info >/dev/null 2>&1 || fail 'docker daemon is unavailable'
docker load --input "$script_dir/$ARCHIVE" >/dev/null
operator_identity=$(docker image inspect --format '{{.Id}}|{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.qinglong.lifecycle"}}|{{index .Config.Labels "io.qinglong.network"}}' "$OPERATOR_IMAGE")
[ "$operator_identity" = "$OPERATOR_ID|$ARCHITECTURE|65532:65532|$SOURCE_REVISION|short-lived|none-by-default" ] || fail 'operator image identity is incompatible'

uid=$(id -u)
gid=$(id -g)
[ "$uid" -eq 0 ] && allow_root_service=true || allow_root_service=false
plan_root="$reconciliation_root/plan"
review_root="$reconciliation_root/review"
diagnostic_root="$reconciliation_root/diagnostics"
application_root="$reconciliation_root/application"
automation_root="$reconciliation_root/automation"
automation_decision_root="$reconciliation_root/automation-decision"
automation_apply_root="$reconciliation_root/automation-apply"
secret_config_root="$reconciliation_root/secret-config"
secret_config_decision_root="$reconciliation_root/secret-config-decision"
secret_config_apply_root="$reconciliation_root/secret-config-apply"
run_history_root="$reconciliation_root/run-history"
completion_root="$reconciliation_root/completion"
command_root="$reconciliation_root/commands"
result_root="$reconciliation_root/results"
target_database="$rehearsal_root/sqlite/qinglong3.sqlite"
issuer_keyring="$rehearsal_root/reconciliation-review-issuer.keyring"
owner_peppers="$rehearsal_root/owner-peppers"
owner_credential="$rehearsal_root/owner-credential.json"
secret_keyring="$rehearsal_root/local-secret-keyring.json"
decision_parent=
secondary_decision_parent=

run_deploy() {
  subcommand=$1
  command_file=$2
  result_file=$3
  input_file=${4:-}
  set -- docker run --rm --read-only --user "$uid:$gid" --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=8m \
    --mount "type=bind,src=$rehearsal_root,dst=$rehearsal_root" \
    --mount "type=bind,src=$capture_root,dst=$capture_root,readonly" \
    --mount "type=bind,src=$reconciliation_root,dst=$reconciliation_root"
  [ -z "$legacy_root" ] || set -- "$@" \
    --mount "type=bind,src=$legacy_root,dst=$legacy_root,readonly"
  [ -z "$decision_parent" ] || set -- "$@" \
    --mount "type=bind,src=$decision_parent,dst=$decision_parent,readonly"
  [ -z "$secondary_decision_parent" ] || set -- "$@" \
    --mount "type=bind,src=$secondary_decision_parent,dst=$secondary_decision_parent,readonly"
  set -- "$@" "$OPERATOR_IMAGE" deploy "$subcommand" \
    --command-file "$command_root/$command_file"
  result_stage="$result_root/.$result_file.$$"
  [ ! -e "$result_stage" ] || fail 'result staging path already exists'
  if "$@" >"$result_stage"; then
    chmod 0600 "$result_stage"
    mv -f "$result_stage" "$result_root/$result_file"
  else
    status=$?
    rm -f "$result_stage"
    return "$status"
  fi
}

if [ "$mode" = prepare ]; then
  [ ! -e "$reconciliation_root" ] || fail 'new reconciliation root already exists'
  reconciliation_parent=${reconciliation_root%/*}
  [ -n "$reconciliation_parent" ] || reconciliation_parent=/
  canonical_directory "$reconciliation_parent" 'reconciliation root parent'
  case "$phase_input" in
    none) legacy_timezone_json=null; legacy_timezone_summary=none ;;
    ''|*[!A-Za-z0-9._+/-]*) fail 'legacy timezone is invalid' ;;
    *) legacy_timezone_json="\"$phase_input\""; legacy_timezone_summary=$phase_input ;;
  esac
  old_umask=$(umask)
  umask 077
  mkdir -m 0700 "$reconciliation_root"
  for directory in plan review diagnostics application automation automation-decision automation-apply secret-config secret-config-decision secret-config-apply run-history completion commands results; do
    mkdir -m 0700 "$reconciliation_root/$directory"
  done
  umask "$old_umask"
  capture_result="$rehearsal_root/results/reconciliation-capture-verify.result.json"
  capture_commit_result="$rehearsal_root/results/reconciliation-capture-commit.result.json"
  grep -q '"status":"verified"' "$capture_result" || fail 'verified reconciliation capture is missing'
  capture_id=$(extract_capture_id "$capture_result")
  capture_bundle_digest=$(extract_digest "$capture_commit_result" bundleDigest)
  capture_head_digest=$(extract_digest "$capture_result" instanceHeadDigest)
  prepared_ms=$(($(date +%s) * 1000))
  cat >"$command_root/plan-prepare.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.plan.prepare","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","allowRootService":$allow_root_service},"request":{"planId":"$PLAN_ID","captureId":"$capture_id","expectedBundleDigest":"$capture_bundle_digest","expectedHeadDigest":"$capture_head_digest","legacyTimezone":$legacy_timezone_json,"preparedAtMs":$prepared_ms}}
EOF
  chmod 0600 "$command_root/plan-prepare.json"
  phase 'prepare bounded reconciliation plan'
  run_deploy reconciliation-plan-prepare plan-prepare.json plan-prepare.result.json
  grep -q '"state":"reconciliation_plan_prepared"' "$result_root/plan-prepare.result.json" || fail 'reconciliation plan was not prepared'
  plan_preparation_digest=$(extract_digest "$result_root/plan-prepare.result.json" preparationDigest)
  committed_ms=$((prepared_ms + 1))
  cat >"$command_root/plan-commit.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.plan.commit","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","allowRootService":$allow_root_service},"request":{"planId":"$PLAN_ID","expectedPreparationDigest":"$plan_preparation_digest","committedAtMs":$committed_ms}}
EOF
  chmod 0600 "$command_root/plan-commit.json"
  phase 'commit bounded reconciliation plan'
  run_deploy reconciliation-plan-commit plan-commit.json plan-commit.result.json
  grep -q '"state":"reconciliation_planned"' "$result_root/plan-commit.result.json" || fail 'reconciliation plan did not commit'
  plan_digest=$(extract_digest "$result_root/plan-commit.result.json" planDigest)
  cat >"$command_root/plan-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.plan.verify","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","allowRootService":$allow_root_service},"request":{"planId":"$PLAN_ID","expectedPlanDigest":"$plan_digest"}}
EOF
  chmod 0600 "$command_root/plan-verify.json"
  run_deploy reconciliation-plan-verify plan-verify.json plan-verify.result.json
  grep -q '"status":"verified"' "$result_root/plan-verify.result.json" || fail 'reconciliation plan verification failed'
  plan_head_digest=$(extract_digest "$result_root/plan-verify.result.json" instanceHeadDigest)

  review_prepared_ms=$((committed_ms + 1))
  cat >"$command_root/review-prepare.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.review.prepare","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","reviewRoot":"$review_root","allowRootService":$allow_root_service},"request":{"reviewId":"$REVIEW_ID","planId":"$PLAN_ID","expectedPlanDigest":"$plan_digest","expectedHeadDigest":"$plan_head_digest","preparedAtMs":$review_prepared_ms}}
EOF
  chmod 0600 "$command_root/review-prepare.json"
  phase 'prepare strong-authentication reconciliation review'
  run_deploy reconciliation-review-prepare review-prepare.json review-prepare.result.json
  grep -q '"state":"reconciliation_review_prepared"' "$result_root/review-prepare.result.json" || fail 'reconciliation review was not prepared'
  review_preparation_digest=$(extract_digest "$result_root/review-prepare.result.json" preparationDigest)

  page_count=0
  record_count=0
  for database in legacy target; do
    for domain in schema_lineage automation secret_and_config run_history plugin_package ai_and_tool identity_policy_audit unknown; do
      for fact_kind in schema_object table; do
        offset=0
        page=0
        while :; do
          stem="$database-$domain-$fact_kind-$page"
          cat >"$command_root/diagnostic-$stem.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.review.diagnostics","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","reviewRoot":"$review_root","allowRootService":$allow_root_service},"request":{"reviewId":"$REVIEW_ID","expectedPreparationDigest":"$review_preparation_digest","database":"$database","domain":"$domain","factKind":"$fact_kind","offset":$offset,"limit":64,"outputPath":"$diagnostic_root/$stem.json"}}
EOF
          chmod 0600 "$command_root/diagnostic-$stem.json"
          run_deploy reconciliation-review-diagnostics "diagnostic-$stem.json" "diagnostic-$stem.result.json"
          grep -q '"state":"reconciliation_review_prepared"' "$result_root/diagnostic-$stem.result.json" || fail "diagnostic page failed: $stem"
          records=$(extract_unsigned "$result_root/diagnostic-$stem.result.json" recordCount)
          record_count=$((record_count + records))
          page_count=$((page_count + 1))
          if grep -q '"complete":true' "$result_root/diagnostic-$stem.result.json"; then
            break
          fi
          offset=$(extract_unsigned "$result_root/diagnostic-$stem.result.json" nextOffset)
          page=$((page + 1))
        done
      done
    done
  done
  cat >"$reconciliation_root/summary.json" <<EOF
{"schemaVersion":1,"schema":"qinglong/local-alpha-reconciliation-rehearsal-summary@v1","status":"operator_decision_required","profile":"$profile","variant":"$VARIANT","sourceRevision":"$SOURCE_REVISION","architecture":"$ARCHITECTURE","capture":{"captureId":"$capture_id","bundleDigest":"$capture_bundle_digest"},"plan":{"planId":"$PLAN_ID","planDigest":"$plan_digest"},"review":{"reviewId":"$REVIEW_ID","preparationDigest":"$review_preparation_digest","diagnosticPages":$page_count,"diagnosticRecords":$record_count},"legacyTimezone":"$legacy_timezone_summary","automaticDecision":"not_authorized","next":"supply_external_review_decisions"}
EOF
  chmod 0600 "$reconciliation_root/summary.json"
  printf '%s\n' \
    'Bounded reconciliation plan and diagnostic pages are ready.' \
    "Summary: $reconciliation_root/summary.json" \
    "Diagnostics: $diagnostic_root" \
    'No review decision was generated or committed. Supply an external owner-private NDJSON decision file to the review phase.'
  exit 0
fi

canonical_directory "$reconciliation_root" 'reconciliation root'
for directory in "$plan_root" "$review_root" "$diagnostic_root" "$application_root" "$automation_root" "$automation_decision_root" "$automation_apply_root" "$secret_config_root" "$secret_config_decision_root" "$secret_config_apply_root" "$run_history_root" "$completion_root" "$command_root" "$result_root"; do
  canonical_directory "$directory" 'reconciliation authority directory'
done
private_decision_file "$phase_input" 'external decision file'
if [ -n "$secondary_input" ]; then
  primary_decision_parent=$decision_parent
  private_decision_file "$secondary_input" 'external review decision file'
  secondary_decision_parent=$decision_parent
  decision_parent=$primary_decision_parent
fi
if [ -n "$legacy_root" ]; then
  non_overlapping "$decision_parent" "$legacy_root" || fail 'external decision file parent must be outside legacy root'
  [ -z "$secondary_decision_parent" ] || non_overlapping "$secondary_decision_parent" "$legacy_root" || fail 'external review decision file parent must be outside legacy root'
fi

if [ "$mode" = review ]; then
  grep -q '"status":"operator_decision_required"' "$reconciliation_root/summary.json" || fail 'review phase is detached from operator-decision state'
  review_preparation_digest=$(extract_digest "$result_root/review-prepare.result.json" preparationDigest)
  review_head_digest=$(extract_digest "$result_root/review-prepare.result.json" instanceHeadDigest)
  if [ -e "$command_root/review-commit.json" ]; then
    committed_ms=$(extract_unsigned "$command_root/review-commit.json" committedAtMs)
  else
    committed_ms=$(($(date +%s) * 1000))
    cat >"$command_root/review-commit.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.review.commit","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","reviewRoot":"$review_root","targetDatabasePath":"$target_database","ownerPepperKeyringDirectory":"$owner_peppers","credentialFilePath":"$owner_credential","issuerKeyringPath":"$issuer_keyring","busyTimeoutMs":100,"allowRootService":$allow_root_service},"request":{"reviewId":"$REVIEW_ID","expectedPreparationDigest":"$review_preparation_digest","expectedHeadDigest":"$review_head_digest","decisionFilePath":"$phase_input","committedAtMs":$committed_ms,"authorizationLifetimeMs":60000}}
EOF
    chmod 0600 "$command_root/review-commit.json"
  fi
  phase 'commit explicit review decisions with real Owner authentication'
  run_deploy reconciliation-review-commit review-commit.json review-commit.result.json "$phase_input"
  grep -q '"state":"reconciliation_reviewed"' "$result_root/review-commit.result.json" || fail 'reconciliation review did not commit'
  review_digest=$(extract_digest "$result_root/review-commit.result.json" reviewDigest)
  cat >"$command_root/review-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.review.verify","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","reviewRoot":"$review_root","issuerKeyringPath":"$issuer_keyring","allowRootService":$allow_root_service},"request":{"reviewId":"$REVIEW_ID","expectedReviewDigest":"$review_digest"}}
EOF
  chmod 0600 "$command_root/review-verify.json"
  run_deploy reconciliation-review-verify review-verify.json review-verify.result.json
  grep -q '"status":"verified"' "$result_root/review-verify.result.json" || fail 'reconciliation review verification failed'
  review_head_digest=$(extract_digest "$result_root/review-verify.result.json" instanceHeadDigest)

  application_prepared_ms=$((committed_ms + 1))
  cat >"$command_root/application-prepare.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.application.prepare","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","reviewRoot":"$review_root","applicationRoot":"$application_root","issuerKeyringPath":"$issuer_keyring","allowRootService":$allow_root_service},"request":{"applicationId":"$APPLICATION_ID","reviewId":"$REVIEW_ID","expectedReviewDigest":"$review_digest","expectedHeadDigest":"$review_head_digest","preparedAtMs":$application_prepared_ms}}
EOF
  chmod 0600 "$command_root/application-prepare.json"
  phase 'prepare reviewed cross-domain application plan'
  run_deploy reconciliation-application-prepare application-prepare.json application-prepare.result.json
  grep -q '"state":"reconciliation_application_prepared"' "$result_root/application-prepare.result.json" || fail 'application plan was not prepared'
  application_preparation_digest=$(extract_digest "$result_root/application-prepare.result.json" preparationDigest)
  application_head_digest=$(extract_digest "$result_root/application-prepare.result.json" instanceHeadDigest)
  application_committed_ms=$((application_prepared_ms + 1))
  cat >"$command_root/application-commit.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.application.commit","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","reviewRoot":"$review_root","applicationRoot":"$application_root","issuerKeyringPath":"$issuer_keyring","allowRootService":$allow_root_service},"request":{"applicationId":"$APPLICATION_ID","expectedPreparationDigest":"$application_preparation_digest","expectedHeadDigest":"$application_head_digest","committedAtMs":$application_committed_ms}}
EOF
  chmod 0600 "$command_root/application-commit.json"
  run_deploy reconciliation-application-commit application-commit.json application-commit.result.json
  grep -q '"state":"reconciliation_application_planned"' "$result_root/application-commit.result.json" || fail 'application plan did not commit'
  application_plan_digest=$(extract_digest "$result_root/application-commit.result.json" applicationPlanDigest)
  cat >"$command_root/application-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.application.verify","options":{"deploymentRoot":"$rehearsal_root","captureRoot":"$capture_root","planRoot":"$plan_root","reviewRoot":"$review_root","applicationRoot":"$application_root","issuerKeyringPath":"$issuer_keyring","allowRootService":$allow_root_service},"request":{"applicationId":"$APPLICATION_ID","expectedApplicationPlanDigest":"$application_plan_digest"}}
EOF
  chmod 0600 "$command_root/application-verify.json"
  run_deploy reconciliation-application-verify application-verify.json application-verify.result.json
  grep -q '"status":"verified"' "$result_root/application-verify.result.json" || fail 'application plan verification failed'
  application_head_digest=$(extract_digest "$result_root/application-verify.result.json" instanceHeadDigest)

  legacy_timezone=$(sed -n 's/^.*"legacyTimezone":"\([^"]*\)".*$/\1/p' "$reconciliation_root/summary.json")
  [ "$legacy_timezone" != none ] || legacy_timezone=
  [ -n "$legacy_timezone" ] && timezone_json="\"$legacy_timezone\"" || timezone_json=null
  automation_prepared_ms=$((application_committed_ms + 1))
  cat >"$command_root/automation-plan.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.plan","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","automationRoot":"$automation_root","allowRootService":$allow_root_service},"request":{"automationId":"$AUTOMATION_ID","applicationId":"$APPLICATION_ID","expectedApplicationPlanDigest":"$application_plan_digest","expectedHeadDigest":"$application_head_digest","decisionFilePath":"$phase_input","projectId":"default","legacyTimezone":$timezone_json,"preparedAtMs":$automation_prepared_ms}}
EOF
  chmod 0600 "$command_root/automation-plan.json"
  phase 'materialize reviewed Automation row plan'
  run_deploy reconciliation-automation-plan automation-plan.json automation-plan.result.json "$phase_input"
  grep -q '"state":"reconciliation_automation_planned"' "$result_root/automation-plan.result.json" || fail 'Automation plan did not materialize'
  grep -q '"outcome":"ready"' "$result_root/automation-plan.result.json" || fail 'Automation plan requires manual resolution or has no applicable rows'
  automation_plan_digest=$(extract_digest "$result_root/automation-plan.result.json" automationPlanDigest)
  automation_head_digest=$(extract_digest "$result_root/automation-plan.result.json" instanceHeadDigest)
  cat >"$command_root/automation-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.verify","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","automationRoot":"$automation_root","allowRootService":$allow_root_service},"request":{"automationId":"$AUTOMATION_ID","expectedAutomationPlanDigest":"$automation_plan_digest"}}
EOF
  chmod 0600 "$command_root/automation-verify.json"
  run_deploy reconciliation-automation-verify automation-verify.json automation-verify.result.json
  grep -q '"status":"verified"' "$result_root/automation-verify.result.json" || fail 'Automation plan verification failed'
  automation_head_digest=$(extract_digest "$result_root/automation-verify.result.json" instanceHeadDigest)

  decision_prepared_ms=$((automation_prepared_ms + 1))
  cat >"$command_root/automation-decision-prepare.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.decision.prepare","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","automationRoot":"$automation_root","automationDecisionRoot":"$automation_decision_root","allowRootService":$allow_root_service},"request":{"decisionId":"$AUTOMATION_DECISION_ID","automationId":"$AUTOMATION_ID","expectedAutomationPlanDigest":"$automation_plan_digest","expectedHeadDigest":"$automation_head_digest","preparedAtMs":$decision_prepared_ms}}
EOF
  chmod 0600 "$command_root/automation-decision-prepare.json"
  run_deploy reconciliation-automation-decision-prepare automation-decision-prepare.json automation-decision-prepare.result.json
  grep -q '"state":"reconciliation_automation_decision_prepared"' "$result_root/automation-decision-prepare.result.json" || fail 'Automation decision authority was not prepared'
  decision_preparation_digest=$(extract_digest "$result_root/automation-decision-prepare.result.json" preparationDigest)
  eligible_count=$(extract_unsigned "$result_root/automation-plan.result.json" eligibleCount)
  conflict_count=$(extract_unsigned "$result_root/automation-plan.result.json" conflictCount)
  row_count=$(extract_unsigned "$result_root/automation-plan.result.json" rowCount)
  [ "$eligible_count" -gt 0 ] && [ "$conflict_count" -eq 0 ] || fail 'Automation plan is not eligible for bounded reviewed application'
  cat >"$reconciliation_root/summary.json" <<EOF
{"schemaVersion":1,"schema":"qinglong/local-alpha-reconciliation-rehearsal-summary@v1","status":"automation_decision_required","profile":"$profile","variant":"$VARIANT","sourceRevision":"$SOURCE_REVISION","architecture":"$ARCHITECTURE","review":{"reviewId":"$REVIEW_ID","reviewDigest":"$review_digest","decisionAuthority":"authenticated_user"},"application":{"applicationId":"$APPLICATION_ID","applicationPlanDigest":"$application_plan_digest"},"automation":{"automationId":"$AUTOMATION_ID","automationPlanDigest":"$automation_plan_digest","rowCount":$row_count,"eligibleCount":$eligible_count,"conflictCount":$conflict_count},"decision":{"decisionId":"$AUTOMATION_DECISION_ID","preparationDigest":"$decision_preparation_digest"},"automaticRowDecision":"not_authorized","next":"supply_external_automation_decisions"}
EOF
  chmod 0600 "$reconciliation_root/summary.json"
  printf '%s\n' \
    'Authenticated review and Automation plan are ready.' \
    "Summary: $reconciliation_root/summary.json" \
    "Automation plan: $automation_root/$AUTOMATION_ID/plan.ndjson" \
    'No Automation row decision was generated or applied. Supply an external owner-private NDJSON decision file to apply-rollback, or pair it with the original review decision for apply-plan.'
  exit 0
fi

if [ "$mode" = complete ]; then
  grep -q '"status":"secret_config_decision_required"' "$reconciliation_root/summary.json" || fail 'completion phase is detached from Secret/Config decision state'
  application_plan_digest=$(extract_digest "$result_root/application-commit.result.json" applicationPlanDigest)
  automation_decision_digest=$(extract_digest "$result_root/automation-decision-commit.result.json" decisionDigest)
  automation_apply_digest=$(extract_digest "$result_root/automation-apply.result.json" applyDigest)
  preservation_digest=$(extract_digest "$result_root/run-history-preserve.result.json" preservationDigest)
  secret_decision_preparation_digest=$(extract_digest "$result_root/secret-config-decision-prepare.result.json" preparationDigest)
  secret_decision_head_digest=$(extract_digest "$result_root/secret-config-decision-prepare.result.json" instanceHeadDigest)
  if [ -e "$command_root/secret-config-decision-commit.json" ]; then
    committed_ms=$(extract_unsigned "$command_root/secret-config-decision-commit.json" committedAtMs)
  else
    committed_ms=$(($(date +%s) * 1000))
    cat >"$command_root/secret-config-decision-commit.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.secret-config.decision.commit","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","secretConfigRoot":"$secret_config_root","secretConfigDecisionRoot":"$secret_config_decision_root","targetDatabasePath":"$target_database","ownerPepperKeyringDirectory":"$owner_peppers","credentialFilePath":"$owner_credential","busyTimeoutMs":100,"allowRootService":$allow_root_service},"request":{"decisionId":"$SECRET_CONFIG_DECISION_ID","secretConfigId":"$SECRET_CONFIG_ID","expectedPreparationDigest":"$secret_decision_preparation_digest","expectedHeadDigest":"$secret_decision_head_digest","decisionFilePath":"$phase_input","committedAtMs":$committed_ms,"authorizationLifetimeMs":60000}}
EOF
    chmod 0600 "$command_root/secret-config-decision-commit.json"
  fi
  phase 'commit explicit Secret/Config decisions with real Owner authentication'
  run_deploy reconciliation-secret-config-decision-commit secret-config-decision-commit.json secret-config-decision-commit.result.json "$phase_input"
  grep -q '"state":"reconciliation_secret_config_reviewed"' "$result_root/secret-config-decision-commit.result.json" || fail 'Secret/Config decisions did not commit'
  grep -q '"outcome":"ready"' "$result_root/secret-config-decision-commit.result.json" || fail 'Secret/Config decisions did not authorize a ready application'
  secret_decision_digest=$(extract_digest "$result_root/secret-config-decision-commit.result.json" decisionDigest)
  cat >"$command_root/secret-config-decision-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.secret-config.decision.verify","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","secretConfigRoot":"$secret_config_root","secretConfigDecisionRoot":"$secret_config_decision_root","allowRootService":$allow_root_service},"request":{"decisionId":"$SECRET_CONFIG_DECISION_ID","secretConfigId":"$SECRET_CONFIG_ID","expectedDecisionDigest":"$secret_decision_digest"}}
EOF
  chmod 0600 "$command_root/secret-config-decision-verify.json"
  run_deploy reconciliation-secret-config-decision-verify secret-config-decision-verify.json secret-config-decision-verify.result.json
  grep -q '"status":"verified"' "$result_root/secret-config-decision-verify.result.json" || fail 'Secret/Config decision verification failed'
  secret_decision_head_digest=$(extract_digest "$result_root/secret-config-decision-verify.result.json" instanceHeadDigest)

  secret_apply_options="\"deploymentRoot\":\"$rehearsal_root\",\"applicationRoot\":\"$application_root\",\"secretConfigRoot\":\"$secret_config_root\",\"secretConfigDecisionRoot\":\"$secret_config_decision_root\",\"secretConfigApplyRoot\":\"$secret_config_apply_root\",\"targetDatabasePath\":\"$target_database\",\"secretKeyringPath\":\"$secret_keyring\",\"ownerPepperKeyringDirectory\":\"$owner_peppers\",\"credentialFilePath\":\"$owner_credential\",\"busyTimeoutMs\":100,\"allowRootService\":$allow_root_service"
  if [ -e "$command_root/secret-config-apply.json" ]; then
    applied_ms=$(extract_unsigned "$command_root/secret-config-apply.json" appliedAtMs)
  else
    applied_ms=$((committed_ms + 1))
    cat >"$command_root/secret-config-apply.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.secret-config.apply","options":{$secret_apply_options},"request":{"decisionId":"$SECRET_CONFIG_DECISION_ID","secretConfigId":"$SECRET_CONFIG_ID","expectedDecisionDigest":"$secret_decision_digest","expectedHeadDigest":"$secret_decision_head_digest","mutationId":"$SECRET_CONFIG_MUTATION_ID","requestId":"alpha-reconciliation-secret-config-apply","appliedAtMs":$applied_ms}}
EOF
    chmod 0600 "$command_root/secret-config-apply.json"
  fi
  phase 'apply reviewed Secret/Config candidates under the bounded operator envelope'
  run_deploy reconciliation-secret-config-apply secret-config-apply.json secret-config-apply.result.json
  grep -q '"state":"reconciliation_secret_config_applied"' "$result_root/secret-config-apply.result.json" || fail 'Secret/Config candidates did not apply'
  secret_apply_digest=$(extract_digest "$result_root/secret-config-apply.result.json" applyDigest)
  secret_applied_head_digest=$(extract_digest "$result_root/secret-config-apply.result.json" instanceHeadDigest)
  cat >"$command_root/secret-config-apply-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.secret-config.apply.verify","options":{$secret_apply_options},"request":{"decisionId":"$SECRET_CONFIG_DECISION_ID","secretConfigId":"$SECRET_CONFIG_ID","expectedApplyDigest":"$secret_apply_digest"}}
EOF
  chmod 0600 "$command_root/secret-config-apply-verify.json"
  run_deploy reconciliation-secret-config-apply-verify secret-config-apply-verify.json secret-config-apply-verify.result.json
  grep -q '"state":"reconciliation_secret_config_applied"' "$result_root/secret-config-apply-verify.result.json" || fail 'applied Secret/Config verification failed'

  completion_options="\"deploymentRoot\":\"$rehearsal_root\",\"applicationRoot\":\"$application_root\",\"completionRoot\":\"$completion_root\",\"automation\":{\"automationRoot\":\"$automation_root\",\"automationDecisionRoot\":\"$automation_decision_root\",\"automationApplyRoot\":\"$automation_apply_root\",\"targetDatabasePath\":\"$target_database\"},\"secretConfig\":{\"secretConfigRoot\":\"$secret_config_root\",\"secretConfigDecisionRoot\":\"$secret_config_decision_root\",\"secretConfigApplyRoot\":\"$secret_config_apply_root\",\"targetDatabasePath\":\"$target_database\"},\"runHistory\":{\"runHistoryRoot\":\"$run_history_root\",\"decisionFilePath\":\"$secondary_input\"},\"allowRootService\":$allow_root_service"
  completion_automation="{\"automationId\":\"$AUTOMATION_ID\",\"decisionId\":\"$AUTOMATION_DECISION_ID\",\"expectedApplyDigest\":\"$automation_apply_digest\"}"
  completion_secret_config="{\"secretConfigId\":\"$SECRET_CONFIG_ID\",\"decisionId\":\"$SECRET_CONFIG_DECISION_ID\",\"expectedApplyDigest\":\"$secret_apply_digest\"}"
  completion_run_history="{\"preservationId\":\"$RUN_HISTORY_PRESERVATION_ID\",\"expectedPreservationDigest\":\"$preservation_digest\"}"
  if [ -e "$command_root/completion.json" ]; then
    completed_ms=$(extract_unsigned "$command_root/completion.json" completedAtMs)
  else
    completed_ms=$((applied_ms + 1))
    cat >"$command_root/completion.json" <<EOF
{"schemaVersion":3,"operation":"local.deployment.reconciliation.complete","options":{$completion_options},"request":{"completionId":"$COMPLETION_ID","applicationId":"$APPLICATION_ID","expectedApplicationPlanDigest":"$application_plan_digest","expectedHeadDigest":"$secret_applied_head_digest","automation":$completion_automation,"secretConfig":$completion_secret_config,"runHistory":$completion_run_history,"completedAtMs":$completed_ms}}
EOF
    chmod 0600 "$command_root/completion.json"
  fi
  phase 'seal cross-domain reconciliation completion while both services remain stopped'
  run_deploy reconciliation-complete completion.json completion.result.json "$secondary_input"
  grep -q '"state":"reconciliation_completed"' "$result_root/completion.result.json" || fail 'cross-domain reconciliation did not complete'
  completion_digest=$(extract_digest "$result_root/completion.result.json" completionDigest)
  completion_head_digest=$(extract_digest "$result_root/completion.result.json" instanceHeadDigest)
  cat >"$command_root/completion-verify.json" <<EOF
{"schemaVersion":3,"operation":"local.deployment.reconciliation.complete.verify","options":{$completion_options},"request":{"completionId":"$COMPLETION_ID","applicationId":"$APPLICATION_ID","expectedCompletionDigest":"$completion_digest","automation":$completion_automation,"secretConfig":$completion_secret_config,"runHistory":$completion_run_history}}
EOF
  chmod 0600 "$command_root/completion-verify.json"
  run_deploy reconciliation-complete-verify completion-verify.json completion-verify.result.json "$secondary_input"
  grep -q '"status":"verified"' "$result_root/completion-verify.result.json" || fail 'cross-domain completion verification failed'
  adapter_count=$(extract_unsigned "$result_root/completion.result.json" adapterCount)
  [ "$adapter_count" -eq 3 ] || fail 'completion did not bind all three reconciliation adapters'
  cat >"$reconciliation_root/summary.json" <<EOF
{"schemaVersion":1,"schema":"qinglong/local-alpha-reconciliation-rehearsal-summary@v1","status":"reconciliation_completed","profile":"$profile","variant":"$VARIANT","sourceRevision":"$SOURCE_REVISION","architecture":"$ARCHITECTURE","review":{"reviewId":"$REVIEW_ID","authority":"authenticated_user"},"automation":{"automationId":"$AUTOMATION_ID","decisionId":"$AUTOMATION_DECISION_ID","decisionDigest":"$automation_decision_digest","applyDigest":"$automation_apply_digest"},"secretConfig":{"secretConfigId":"$SECRET_CONFIG_ID","decisionId":"$SECRET_CONFIG_DECISION_ID","decisionDigest":"$secret_decision_digest","applyDigest":"$secret_apply_digest"},"runHistory":{"preservationId":"$RUN_HISTORY_PRESERVATION_ID","preservationDigest":"$preservation_digest"},"completion":{"completionId":"$COMPLETION_ID","completionDigest":"$completion_digest","adapterCount":$adapter_count,"instanceHeadDigest":"$completion_head_digest"},"target":"stopped","legacy":"stopped","targetRestart":"not_authorized","legacyRestart":"not_authorized","next":"independent_restart_authority_required"}
EOF
  chmod 0600 "$reconciliation_root/summary.json"
  printf '%s\n' \
    'Automation, Secret/Config, and Run History evidence reached verified reconciliation completion.' \
    "Summary: $reconciliation_root/summary.json" \
    "Completion evidence: $result_root/completion-verify.result.json" \
    'Target and Legacy remain stopped. Restart requires a separate authority ceremony.'
  exit 0
fi

grep -q '"status":"automation_decision_required"' "$reconciliation_root/summary.json" || fail 'Automation application phase is detached from Automation decision state'
decision_preparation_digest=$(extract_digest "$result_root/automation-decision-prepare.result.json" preparationDigest)
decision_head_digest=$(extract_digest "$result_root/automation-decision-prepare.result.json" instanceHeadDigest)
if [ -e "$command_root/automation-decision-commit.json" ]; then
  committed_ms=$(extract_unsigned "$command_root/automation-decision-commit.json" committedAtMs)
else
  committed_ms=$(($(date +%s) * 1000))
  cat >"$command_root/automation-decision-commit.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.decision.commit","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","automationRoot":"$automation_root","automationDecisionRoot":"$automation_decision_root","targetDatabasePath":"$target_database","ownerPepperKeyringDirectory":"$owner_peppers","credentialFilePath":"$owner_credential","busyTimeoutMs":100,"allowRootService":$allow_root_service},"request":{"decisionId":"$AUTOMATION_DECISION_ID","automationId":"$AUTOMATION_ID","expectedPreparationDigest":"$decision_preparation_digest","expectedHeadDigest":"$decision_head_digest","decisionFilePath":"$phase_input","committedAtMs":$committed_ms,"authorizationLifetimeMs":60000}}
EOF
  chmod 0600 "$command_root/automation-decision-commit.json"
fi
phase 'commit explicit Automation row decisions with real Owner authentication'
run_deploy reconciliation-automation-decision-commit automation-decision-commit.json automation-decision-commit.result.json "$phase_input"
grep -q '"state":"reconciliation_automation_reviewed"' "$result_root/automation-decision-commit.result.json" || fail 'Automation decisions did not commit'
decision_digest=$(extract_digest "$result_root/automation-decision-commit.result.json" decisionDigest)
cat >"$command_root/automation-decision-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.decision.verify","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","automationRoot":"$automation_root","automationDecisionRoot":"$automation_decision_root","allowRootService":$allow_root_service},"request":{"decisionId":"$AUTOMATION_DECISION_ID","automationId":"$AUTOMATION_ID","expectedDecisionDigest":"$decision_digest"}}
EOF
chmod 0600 "$command_root/automation-decision-verify.json"
run_deploy reconciliation-automation-decision-verify automation-decision-verify.json automation-decision-verify.result.json
grep -q '"status":"verified"' "$result_root/automation-decision-verify.result.json" || fail 'Automation decision verification failed'
decision_head_digest=$(extract_digest "$result_root/automation-decision-verify.result.json" instanceHeadDigest)

apply_options="\"deploymentRoot\":\"$rehearsal_root\",\"applicationRoot\":\"$application_root\",\"automationRoot\":\"$automation_root\",\"automationDecisionRoot\":\"$automation_decision_root\",\"automationApplyRoot\":\"$automation_apply_root\",\"targetDatabasePath\":\"$target_database\",\"ownerPepperKeyringDirectory\":\"$owner_peppers\",\"credentialFilePath\":\"$owner_credential\",\"busyTimeoutMs\":100,\"allowRootService\":$allow_root_service"
if [ -e "$command_root/automation-apply.json" ]; then
  applied_ms=$(extract_unsigned "$command_root/automation-apply.json" appliedAtMs)
else
  applied_ms=$((committed_ms + 1))
  cat >"$command_root/automation-apply.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.apply","options":{$apply_options},"request":{"decisionId":"$AUTOMATION_DECISION_ID","automationId":"$AUTOMATION_ID","expectedDecisionDigest":"$decision_digest","expectedHeadDigest":"$decision_head_digest","mutationId":"$AUTOMATION_MUTATION_ID","requestId":"alpha-reconciliation-automation-apply","appliedAtMs":$applied_ms}}
EOF
  chmod 0600 "$command_root/automation-apply.json"
fi
phase 'apply reviewed Automation rows under the bounded operator envelope'
run_deploy reconciliation-automation-apply automation-apply.json automation-apply.result.json
grep -q '"state":"reconciliation_automation_applied"' "$result_root/automation-apply.result.json" || fail 'Automation rows did not apply'
apply_digest=$(extract_digest "$result_root/automation-apply.result.json" applyDigest)
applied_head_digest=$(extract_digest "$result_root/automation-apply.result.json" instanceHeadDigest)
cat >"$command_root/automation-apply-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.apply.verify","options":{$apply_options},"request":{"decisionId":"$AUTOMATION_DECISION_ID","automationId":"$AUTOMATION_ID","expectedApplyDigest":"$apply_digest"}}
EOF
chmod 0600 "$command_root/automation-apply-verify.json"
run_deploy reconciliation-automation-apply-verify automation-apply-verify.json automation-apply-verify.result.json
grep -q '"state":"reconciliation_automation_applied"' "$result_root/automation-apply-verify.result.json" || fail 'applied Automation verification failed'

if [ "$mode" = apply-plan ]; then
  application_plan_digest=$(extract_digest "$result_root/application-commit.result.json" applicationPlanDigest)
  preserved_ms=$((applied_ms + 1))
  cat >"$command_root/run-history-preserve.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.run-history.preserve","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","runHistoryRoot":"$run_history_root","allowRootService":$allow_root_service},"request":{"preservationId":"$RUN_HISTORY_PRESERVATION_ID","applicationId":"$APPLICATION_ID","expectedApplicationPlanDigest":"$application_plan_digest","expectedHeadDigest":"$applied_head_digest","decisionFilePath":"$secondary_input","preservedAtMs":$preserved_ms}}
EOF
  chmod 0600 "$command_root/run-history-preserve.json"
  phase 'preserve dual-sided terminal Run History before Secret/Config advances the head'
  run_deploy reconciliation-run-history-preserve run-history-preserve.json run-history-preserve.result.json "$secondary_input"
  grep -q '"state":"reconciliation_run_history_preserved"' "$result_root/run-history-preserve.result.json" || fail 'Run History preservation failed'
  preservation_digest=$(extract_digest "$result_root/run-history-preserve.result.json" preservationDigest)
  cat >"$command_root/run-history-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.run-history.verify","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","runHistoryRoot":"$run_history_root","allowRootService":$allow_root_service},"request":{"preservationId":"$RUN_HISTORY_PRESERVATION_ID","applicationId":"$APPLICATION_ID","expectedPreservationDigest":"$preservation_digest","decisionFilePath":"$secondary_input"}}
EOF
  chmod 0600 "$command_root/run-history-verify.json"
  run_deploy reconciliation-run-history-verify run-history-verify.json run-history-verify.result.json "$secondary_input"
  grep -q '"status":"verified"' "$result_root/run-history-verify.result.json" || fail 'Run History preservation verification failed'
  legacy_history_facts=$(extract_unsigned "$result_root/run-history-preserve.result.json" legacyFactCount)
  target_history_facts=$(extract_unsigned "$result_root/run-history-preserve.result.json" targetFactCount)
  [ "$legacy_history_facts" -gt 0 ] && [ "$target_history_facts" -gt 0 ] || fail 'Run History evidence is not dual-sided'

  secret_prepared_ms=$((preserved_ms + 1))
  cat >"$command_root/secret-config-plan.json" <<EOF
{"schemaVersion":2,"operation":"local.deployment.reconciliation.secret-config.plan","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","secretConfigRoot":"$secret_config_root","automationApplyRoot":"$automation_apply_root","allowRootService":$allow_root_service},"request":{"secretConfigId":"$SECRET_CONFIG_ID","applicationId":"$APPLICATION_ID","expectedApplicationPlanDigest":"$application_plan_digest","expectedHeadDigest":"$applied_head_digest","decisionFilePath":"$secondary_input","projectId":"default","preparedAtMs":$secret_prepared_ms,"automation":{"automationId":"$AUTOMATION_ID","decisionId":"$AUTOMATION_DECISION_ID","expectedApplyDigest":"$apply_digest"}}}
EOF
  chmod 0600 "$command_root/secret-config-plan.json"
  phase 'materialize reviewed Secret/Config candidate plan'
  run_deploy reconciliation-secret-config-plan secret-config-plan.json secret-config-plan.result.json "$secondary_input"
  sed -n '1p' "$result_root/secret-config-plan.result.json" >&2
  grep -q '"state":"reconciliation_secret_config_planned"' "$result_root/secret-config-plan.result.json" || fail 'Secret/Config plan did not materialize'
  grep -q '"outcome":"ready"' "$result_root/secret-config-plan.result.json" || fail 'Secret/Config plan is manual-required or has no applicable candidates'
  secret_config_plan_digest=$(extract_digest "$result_root/secret-config-plan.result.json" secretConfigPlanDigest)
  cat >"$command_root/secret-config-verify.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.secret-config.verify","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","secretConfigRoot":"$secret_config_root","allowRootService":$allow_root_service},"request":{"secretConfigId":"$SECRET_CONFIG_ID","expectedSecretConfigPlanDigest":"$secret_config_plan_digest"}}
EOF
  chmod 0600 "$command_root/secret-config-verify.json"
  run_deploy reconciliation-secret-config-verify secret-config-verify.json secret-config-verify.result.json
  grep -q '"status":"verified"' "$result_root/secret-config-verify.result.json" || fail 'Secret/Config plan verification failed'
  secret_config_head_digest=$(extract_digest "$result_root/secret-config-verify.result.json" instanceHeadDigest)

  secret_decision_prepared_ms=$((secret_prepared_ms + 1))
  cat >"$command_root/secret-config-decision-prepare.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.secret-config.decision.prepare","options":{"deploymentRoot":"$rehearsal_root","applicationRoot":"$application_root","secretConfigRoot":"$secret_config_root","secretConfigDecisionRoot":"$secret_config_decision_root","allowRootService":$allow_root_service},"request":{"decisionId":"$SECRET_CONFIG_DECISION_ID","secretConfigId":"$SECRET_CONFIG_ID","expectedSecretConfigPlanDigest":"$secret_config_plan_digest","expectedHeadDigest":"$secret_config_head_digest","preparedAtMs":$secret_decision_prepared_ms}}
EOF
  chmod 0600 "$command_root/secret-config-decision-prepare.json"
  run_deploy reconciliation-secret-config-decision-prepare secret-config-decision-prepare.json secret-config-decision-prepare.result.json
  grep -q '"state":"reconciliation_secret_config_decision_prepared"' "$result_root/secret-config-decision-prepare.result.json" || fail 'Secret/Config decision authority was not prepared'
  secret_decision_preparation_digest=$(extract_digest "$result_root/secret-config-decision-prepare.result.json" preparationDigest)
  secret_rows=$(extract_unsigned "$result_root/secret-config-plan.result.json" rowCount)
  eligible_bindings=$(extract_unsigned "$result_root/secret-config-plan.result.json" eligibleBindingCount)
  eligible_preservations=$(extract_unsigned "$result_root/secret-config-plan.result.json" eligiblePreservationCount)
  target_conflicts=$(extract_unsigned "$result_root/secret-config-plan.result.json" targetConflictCount)
  unadapted_configs=$(extract_unsigned "$result_root/secret-config-plan.result.json" unadaptedLegacyConfigCount)
  [ $((eligible_bindings + eligible_preservations)) -gt 0 ] && [ "$target_conflicts" -eq 0 ] && [ "$unadapted_configs" -eq 0 ] || fail 'Secret/Config plan is not eligible for reviewed completion'
  cat >"$reconciliation_root/summary.json" <<EOF
{"schemaVersion":1,"schema":"qinglong/local-alpha-reconciliation-rehearsal-summary@v1","status":"secret_config_decision_required","profile":"$profile","variant":"$VARIANT","sourceRevision":"$SOURCE_REVISION","architecture":"$ARCHITECTURE","review":{"reviewId":"$REVIEW_ID","authority":"authenticated_user"},"application":{"applicationId":"$APPLICATION_ID","applicationPlanDigest":"$application_plan_digest"},"automation":{"automationId":"$AUTOMATION_ID","decisionId":"$AUTOMATION_DECISION_ID","decisionDigest":"$decision_digest","applyDigest":"$apply_digest"},"runHistory":{"preservationId":"$RUN_HISTORY_PRESERVATION_ID","preservationDigest":"$preservation_digest","legacyFactCount":$legacy_history_facts,"targetFactCount":$target_history_facts},"secretConfig":{"secretConfigId":"$SECRET_CONFIG_ID","secretConfigPlanDigest":"$secret_config_plan_digest","rowCount":$secret_rows,"eligibleBindingCount":$eligible_bindings,"eligiblePreservationCount":$eligible_preservations,"targetConflictCount":$target_conflicts,"unadaptedLegacyConfigCount":$unadapted_configs},"secretConfigDecision":{"decisionId":"$SECRET_CONFIG_DECISION_ID","preparationDigest":"$secret_decision_preparation_digest"},"target":"stopped","legacy":"stopped","automaticCandidateDecision":"not_authorized","next":"supply_external_secret_config_decisions"}
EOF
  chmod 0600 "$reconciliation_root/summary.json"
  printf '%s\n' \
    'Automation application, dual Run History preservation, and Secret/Config plan are ready.' \
    "Summary: $reconciliation_root/summary.json" \
    "Secret/Config plan: $secret_config_root/$SECRET_CONFIG_ID/plan.ndjson" \
    'No Secret/Config candidate decision was generated or applied. Supply an external owner-private NDJSON decision file to the complete phase.'
  exit 0
fi

if [ -e "$command_root/automation-rollback.json" ]; then
  rolled_back_ms=$(extract_unsigned "$command_root/automation-rollback.json" rolledBackAtMs)
else
  rolled_back_ms=$((applied_ms + 1))
  cat >"$command_root/automation-rollback.json" <<EOF
{"schemaVersion":1,"operation":"local.deployment.reconciliation.automation.apply.rollback","options":{$apply_options},"request":{"decisionId":"$AUTOMATION_DECISION_ID","automationId":"$AUTOMATION_ID","expectedApplyDigest":"$apply_digest","expectedHeadDigest":"$applied_head_digest","rolledBackAtMs":$rolled_back_ms}}
EOF
  chmod 0600 "$command_root/automation-rollback.json"
fi
phase 'explicitly roll back the reviewed Automation application'
run_deploy reconciliation-automation-apply-rollback automation-rollback.json automation-rollback.result.json
grep -q '"state":"reconciliation_automation_rolled_back"' "$result_root/automation-rollback.result.json" || fail 'Automation rollback did not complete'
rollback_head_digest=$(extract_digest "$result_root/automation-rollback.result.json" instanceHeadDigest)
run_deploy reconciliation-automation-apply-verify automation-apply-verify.json automation-rollback-verify.result.json
grep -q '"state":"reconciliation_automation_rolled_back"' "$result_root/automation-rollback-verify.result.json" || fail 'rolled-back Automation verification failed'
adopted_tasks=$(extract_unsigned "$result_root/automation-apply.result.json" adoptedTaskCount)
adopted_triggers=$(extract_unsigned "$result_root/automation-apply.result.json" adoptedTriggerCount)
cat >"$reconciliation_root/summary.json" <<EOF
{"schemaVersion":1,"schema":"qinglong/local-alpha-reconciliation-rehearsal-summary@v1","status":"reconciliation_automation_rolled_back","profile":"$profile","variant":"$VARIANT","sourceRevision":"$SOURCE_REVISION","architecture":"$ARCHITECTURE","review":{"reviewId":"$REVIEW_ID","authority":"authenticated_user"},"automation":{"automationId":"$AUTOMATION_ID","decisionId":"$AUTOMATION_DECISION_ID","decisionDigest":"$decision_digest","applyDigest":"$apply_digest","adoptedTaskCount":$adopted_tasks,"adoptedTriggerCount":$adopted_triggers,"rollbackHeadDigest":"$rollback_head_digest"},"target":"restored_to_pre_automation_snapshot","completion":"not_attempted","targetRestart":"not_attempted","legacyRestart":"not_attempted","next":"review_rollback_evidence"}
EOF
chmod 0600 "$reconciliation_root/summary.json"
printf '%s\n' \
  'Reviewed Automation application and explicit rollback completed.' \
  "Summary: $reconciliation_root/summary.json" \
  "Apply evidence: $result_root/automation-apply-verify.result.json" \
  "Rollback evidence: $result_root/automation-rollback-verify.result.json" \
  'No reconciliation completion, target restart, Legacy restart, Secret/Config application, or Run History mutation was attempted.'
