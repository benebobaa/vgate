#!/usr/bin/env bash
# Decides whether a merge request the guard marked "needs a human" has that human's approval.
#
#   approval-check.sh <guard result json>
#
# Passes (exit 0) only when an eligible approver's latest approval of the merge request is newer than its latest push.
# Eligible: the users and group members in VGATE_APPROVERS, never the merge request's author. Fails closed: any API
# error, unreadable timestamp or missing variable is "not approved".
#
# Needs: CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID (GitLab sets them), VGATE_API_TOKEN (a masked project or
# group access token with read_api: the job token cannot read approvals), VGATE_APPROVERS (comma-separated usernames
# and `group:<full/path>` entries), and curl and jq.
set -euo pipefail

guard_result=${1:?usage: approval-check.sh <guard result json>}
: "${CI_API_V4_URL:?}" "${CI_PROJECT_ID:?}" "${CI_MERGE_REQUEST_IID:?}"

findings() {
  echo "The guard found changes that weaken or move the expectations:"
  jq -r '
    .summary // empty,
    (.data.findings // [] | .[] |
      "  - " + ((.rule // .kind // "finding") | tostring) + ": " + (if .file then .file + ": " else "" end) +
      ((.detail // .message // .) | if type == "string" then . else tojson end))
  ' "$guard_result" 2>/dev/null || cat "$guard_result"
}

refuse() {
  findings
  echo
  echo "NOT APPROVED: $1"
  echo "An eligible approver ($VGATE_APPROVERS_SHOWN) approves the merge request, then re-runs this job."
  exit 1
}

VGATE_APPROVERS_SHOWN=${VGATE_APPROVERS:-none configured}
[ -n "${VGATE_API_TOKEN:-}" ] || refuse "VGATE_API_TOKEN is not set (a masked token with read_api; see docs/ci.md)"
[ -n "${VGATE_APPROVERS:-}" ] || refuse "VGATE_APPROVERS is empty: nobody is eligible to approve"

api() { # <path> -> JSON on stdout; fails on any HTTP error
  curl -fsS --retry 2 -H "PRIVATE-TOKEN: $VGATE_API_TOKEN" "$CI_API_V4_URL$1"
}

# Every page of a list endpoint, as one array.
api_all() { # <path with query>
  local page=1 out='[]' chunk
  while [ "$page" -le 50 ]; do
    chunk=$(api "$1&per_page=100&page=$page")
    [ "$(jq 'length' <<<"$chunk")" -gt 0 ] || break
    out=$(jq -s 'add' <(echo "$out") <(echo "$chunk"))
    page=$((page + 1))
  done
  echo "$out"
}

mr="/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID"
author=$(api "$mr" | jq -r '.author.username') || refuse "cannot read the merge request through the API"

# The latest push, by the server's clock: a commit date is whatever the committer wrote, a diff version is not.
pushed_at=$(api "$mr/versions" | jq -r 'max_by(.id).created_at') || refuse "cannot read the merge request's versions"

eligible=()
IFS=',' read -r -a entries <<<"$VGATE_APPROVERS"
for entry in "${entries[@]}"; do
  entry=$(echo "$entry" | xargs)
  [ -n "$entry" ] || continue
  if [[ $entry == group:* ]]; then
    group=$(jq -rn --arg path "${entry#group:}" '$path | @uri')
    members=$(api_all "/groups/$group/members/all?state=active") || refuse "cannot read the members of ${entry#group:}"
    while IFS= read -r user; do eligible+=("$user"); done < <(jq -r '.[].username' <<<"$members")
  else
    eligible+=("${entry#@}")
  fi
done

notes=$(api_all "$mr/notes?sort=asc&order_by=created_at") || refuse "cannot read the merge request's notes"

# Per user, the latest approve/unapprove system note; approved when it is an approval newer than the latest push.
approved_by=$(
  jq -r --arg pushed "$pushed_at" --arg author "$author" --args '
    def epoch: sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601;
    ($ARGS.positional) as $eligible
    | [ .[] | select(.system == true)
        | select(.body == "approved this merge request" or .body == "unapproved this merge request")
        | select(.author.username as $u | $eligible | index($u))
        | select(.author.username != $author) ]
    | group_by(.author.username)
    | map(max_by(.created_at | epoch))
    | map(select(.body == "approved this merge request" and ((.created_at | epoch) > ($pushed | epoch))))
    | .[].author.username
  ' "${eligible[@]}" <<<"$notes"
) || refuse "cannot evaluate the approvals (unexpected API data)"

if [ -z "$approved_by" ]; then
  refuse "no eligible approval after the latest push ($pushed_at); the author ($author) cannot approve their own change"
fi

findings
echo
echo "APPROVED after the latest push ($pushed_at) by: $(echo "$approved_by" | paste -sd, -)"
