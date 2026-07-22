#!/usr/bin/env bash
# Fails if main or the bump branch has moved since prepare recorded base_sha/
# head_sha. Shared by two call sites in publish-stable: an early, cheap check
# (skip build/sign entirely if the release is already stale) and a final
# check immediately before the irreversible `npm publish` call (closes the
# window build+sign+the registry check would otherwise leave open). Cleans
# up the bump PR/branch on abort so a re-dispatch from current main starts
# clean. Expects GH_TOKEN, BASE_SHA, HEAD_SHA, BRANCH, PR_NUMBER, and
# GITHUB_REPOSITORY in the environment; run from a checkout of head_sha.
set -euo pipefail

git fetch origin main --depth=1
CURRENT_MAIN=$(git rev-parse FETCH_HEAD)
CURRENT_HEAD=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .head.sha)

if [ "$CURRENT_MAIN" != "$BASE_SHA" ] || [ "$CURRENT_HEAD" != "$HEAD_SHA" ]; then
  echo "::error::The release moved since prepare (main ${BASE_SHA}->${CURRENT_MAIN}, head ${HEAD_SHA}->${CURRENT_HEAD}). main's strict rule would block the merge and the tag would diverge from npm. Re-dispatch to release from current main."
  gh pr close "$PR_NUMBER" --delete-branch || git push origin --delete "$BRANCH" || true
  exit 1
fi
echo "No movement since prepare; safe to proceed."
