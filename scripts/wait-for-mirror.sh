#!/usr/bin/env bash
# Observe Pull mirrors; optionally notify them through a small GitHub push.
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo 'Usage: wait-for-mirror.sh SOURCE MIRROR REF [branch|tag]' >&2
  exit 2
fi
source=$1
mirror=$2
ref=$3
ref_type=${4:-branch}
wait_seconds=${QL_MIRROR_WAIT_SECONDS:-600}
poll_interval=${QL_MIRROR_POLL_INTERVAL:-30}
query_timeout=${QL_MIRROR_QUERY_TIMEOUT:-20}
include_version_branch=${QL_MIRROR_INCLUDE_VERSION_BRANCH:-false}
notify_repo=${QL_MIRROR_NOTIFY_REPO:-}
retry_after=${QL_MIRROR_RETRY_AFTER_SECONDS:-310}
notify_on_start=${QL_MIRROR_NOTIFY_ON_START:-true}

timings=("$wait_seconds" "$poll_interval" "$query_timeout")
if [[ -n "$notify_repo" ]]; then timings+=("$retry_after"); fi
for value in "${timings[@]}"; do
  if [[ ! "$value" =~ ^[1-9][0-9]{0,4}$ ]] || (( value > 86400 )); then
    echo 'Mirror timing values must be integers between 1 and 86400 seconds' >&2
    exit 2
  fi
done
case "$ref_type" in
  branch) refs=("refs/heads/$ref") ;;
  tag)
    refs=("refs/tags/$ref")
    if [[ "$include_version_branch" == true ]]; then
      refs+=("refs/heads/$ref")
    fi
    ;;
  *) echo 'Mirror ref type must be branch or tag' >&2; exit 2 ;;
esac
if [[ "$include_version_branch" != true && "$include_version_branch" != false ]]; then
  echo 'QL_MIRROR_INCLUDE_VERSION_BRANCH must be true or false' >&2
  exit 2
fi
if [[ "$notify_on_start" != true && "$notify_on_start" != false ]]; then
  echo 'QL_MIRROR_NOTIFY_ON_START must be true or false' >&2
  exit 2
fi
for requested_ref in "${refs[@]}"; do
  git check-ref-format "$requested_ref"
done
command -v timeout >/dev/null || { echo 'GNU timeout is required' >&2; exit 2; }
if [[ -n "$notify_repo" ]]; then
  if [[ ! "$notify_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo 'QL_MIRROR_NOTIFY_REPO must be a GitHub owner/repository' >&2
    exit 2
  fi
  command -v gh >/dev/null || { echo 'GitHub CLI is required for notifications' >&2; exit 2; }
fi
export GIT_TERMINAL_PROMPT=0
polling=false

notification_command() {
  local budget=$((notification_deadline - SECONDS))
  if (( budget <= 0 )); then return 1; fi
  if (( budget > 10 )); then budget=10; fi
  timeout --signal=KILL "${budget}s" "$@"
}

notify_static_mirror() {
  local notification_deadline=$((SECONDS + 30))
  if [[ "$polling" == true ]] && (( notification_deadline > wait_seconds )); then
    notification_deadline=$wait_seconds
  fi
  local trigger_ref=refs/heads/gitee-sync-trigger
  local attempt remote_refs source_sha parent tree commit delay remaining
  local commit_args
  if ! remote_refs=$(notification_command git ls-remote --refs "$source" "${refs[0]}"); then
    echo '::warning::Could not read the published source; continuing mirror verification'
    return 1
  fi
  source_sha=${remote_refs%%$'\t'*}
  if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::Published source ref ${refs[0]} does not exist"
    return 2
  fi
  for attempt in 1 2 3; do
    if (( attempt > 1 )); then
      delay=$((attempt * 2 - 2))
      remaining=$((notification_deadline - SECONDS))
      if (( remaining <= delay )); then break; fi
      sleep "$delay"
    fi
    # Refresh the parent on every attempt. REST avoids the Git push endpoint's
    # transient 500s, and non-forced updates preserve concurrent notifications.
    if parent=$(notification_command gh api "repos/$notify_repo/git/ref/heads/gitee-sync-trigger" --jq '.object.sha' 2>&1); then
      if ! tree=$(notification_command gh api "repos/$notify_repo/git/commits/$parent" --jq '.tree.sha'); then
        echo "::warning::Could not read notification history (attempt $attempt)"
        continue
      fi
    elif [[ "$parent" == *'(HTTP 404)'* ]]; then
      parent=''
      # A new notification branch starts with one tiny marker, never artifacts.
      # Later commits reuse this tree and have no changed files in the webhook.
      if ! tree=$(printf '%s' '{"tree":[{"path":".gitee-sync-trigger","mode":"100644","type":"blob","content":"Gitee Pull mirror notifications.\n"}]}' |
        notification_command gh api --method POST "repos/$notify_repo/git/trees" --input - --jq '.sha'); then
        echo "::warning::Could not create notification tree (attempt $attempt)"
        continue
      fi
    else
      echo "::warning::Could not read notification ref (attempt $attempt)"
      continue
    fi
    commit_args=(-f "tree=$tree" -f "message=Trigger Gitee mirror for ${refs[0]} at $source_sha")
    if [[ -n "$parent" ]]; then commit_args+=(-f "parents[]=$parent"); fi
    if ! commit=$(notification_command gh api --method POST "repos/$notify_repo/git/commits" "${commit_args[@]}" --jq '.sha'); then
      echo "::warning::Could not create notification commit (attempt $attempt)"
      continue
    fi
    if [[ -n "$parent" ]]; then
      if notification_command gh api --method PATCH "repos/$notify_repo/git/refs/heads/gitee-sync-trigger" -f "sha=$commit" -F force=false --silent; then
        echo '::notice::Sent a small GitHub push event via REST to trigger the Gitee Pull mirror'
        return 0
      fi
    elif notification_command gh api --method POST "repos/$notify_repo/git/refs" -f "ref=$trigger_ref" -f "sha=$commit" --silent; then
      echo '::notice::Sent a small GitHub push event via REST to trigger the Gitee Pull mirror'
      return 0
    fi
    echo "::warning::Mirror notification update failed (attempt $attempt)"
  done
  echo '::warning::Could not send the mirror notification; continuing mirror verification'
  return 1
}

if [[ -n "$notify_repo" && "$notify_on_start" == true ]]; then
  if notify_static_mirror; then :; elif [[ $? -eq 2 ]]; then exit 1; fi
fi

SECONDS=0
polling=true
attempt=0
retried=false
last_source='(not read)'
last_mirror='(not read)'
while (( SECONDS < wait_seconds )); do
  attempt=$((attempt + 1))
  outputs=()
  ready=true
  # Re-read the source after the mirror so a moving source cannot pass with
  # the previous SHA. --refs compares annotated tag objects as well as branches.
  urls=("$source" "$mirror" "$source")
  labels=('source' 'mirror' 'source confirmation')
  for index in 0 1 2; do
    remaining=$((wait_seconds - SECONDS))
    if (( remaining <= 0 )); then
      ready=false
      break
    fi
    budget=$query_timeout
    if (( budget > remaining )); then budget=$remaining; fi
    if ! output=$(timeout --signal=KILL "${budget}s" git ls-remote --refs \
      "${urls[$index]}" "${refs[@]}" | LC_ALL=C sort); then
      echo "::warning::Could not read ${labels[$index]} refs on attempt $attempt; retrying"
      ready=false
      break
    fi
    if (( index == 0 )); then last_source=$output; fi
    if (( index == 1 )); then last_mirror=$output; fi
    for requested_ref in "${refs[@]}"; do
      found=false
      while IFS=$'\t' read -r sha returned_ref; do
        if [[ "$returned_ref" == "$requested_ref" && "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
          found=true
        fi
      done <<< "$output"
      if [[ "$found" == false ]]; then
        echo "::notice::${labels[$index]} is missing $requested_ref; waiting"
        ready=false
        break
      fi
    done
    if [[ "$ready" == false ]]; then break; fi
    outputs+=("$output")
    # Only confirm a source when the initial source and mirror reads match.
    if (( index == 1 )) && [[ "${outputs[0]}" != "${outputs[1]}" ]]; then
      ready=false
      break
    fi
  done
  if [[ "$ready" == true && "${outputs[0]}" == "${outputs[2]}" ]]; then
    echo "::notice::Mirror matches the latest source refs after ${SECONDS}s"
    printf '%s\n' "${outputs[2]}"
    exit 0
  fi
  echo "Waiting for mirror (attempt $attempt, ${SECONDS}/${wait_seconds}s)"
  remaining=$((wait_seconds - SECONDS))
  if (( remaining <= 0 )); then break; fi
  # Gitee requires five minutes between sync requests. Retry once after that
  # interval without restarting the polling deadline.
  if [[ -n "$notify_repo" && "$retried" == false ]] && (( SECONDS >= retry_after )); then
    echo '::notice::Retrying the GitHub notification after the Gitee sync interval'
    if notify_static_mirror; then :; elif [[ $? -eq 2 ]]; then exit 1; fi
    retried=true
    continue
  fi
  delay=$poll_interval
  if (( delay > remaining )); then delay=$remaining; fi
  if [[ -n "$notify_repo" && "$retried" == false ]] && (( SECONDS < retry_after && delay > retry_after - SECONDS )); then
    delay=$((retry_after - SECONDS))
  fi
  sleep "$delay"
done

echo "::error::Mirror did not match the latest source refs within ${wait_seconds}s"
printf 'Last source refs:\n%s\nLast mirror refs:\n%s\n' "$last_source" "$last_mirror"
exit 1
