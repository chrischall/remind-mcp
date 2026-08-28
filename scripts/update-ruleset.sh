#!/usr/bin/env bash
# Apply this repo's branch protection + merge policy.
#
# The required check is the `ci-gated` COMMIT STATUS — a status context, not a
# job name. A ruleset requiring a context nothing posts blocks every PR forever,
# so this must stay in step with `gate-mode: status` in .github/workflows/ci.yml.
set -euo pipefail
REPO="${1:-chrischall/remind-mcp}"

# Merge policy. `allow_auto_merge` is load-bearing: with it off, the arm step
# fails "Auto merge is not allowed for this repository" and armed PRs sit open.
# `squash_merge_commit_title=PR_TITLE` makes the PR title authoritative even on
# a single-commit PR, where GitHub otherwise squashes using the COMMIT subject.
gh api -X PATCH "repos/$REPO" \
  -F allow_auto_merge=true \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY >/dev/null
echo "merge policy set on $REPO"

gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON'
{
  "name": "protect-default",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      } },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "ci-gated" }]
      } }
  ]
}
JSON
echo "ruleset applied to $REPO (required check: ci-gated)"
