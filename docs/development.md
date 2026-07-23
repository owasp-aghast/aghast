<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="configuration.md">&larr; Configuration Reference</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>
</p>

---

# Development

## Setup

Clone the repo and install dependencies:

```bash
git clone https://github.com/owasp-aghast/aghast.git
cd aghast
npm install
```

Run this again after pulling changes to keep dependencies in sync with the lockfile.

During development, you can use the npm scripts directly:

```bash
npm run scan -- <repo-path> [options]
npm run new-check -- [options]
npm run build-config -- --config-dir <path> [options]  # Build or edit runtime-config.json
npm run build
npm test
npm run test:coverage  # Run the unit test suite with Node.js coverage enabled
npm run test:ci        # Run tests with spec and JUnit reporters (for CI)
npm run test:semgrep   # Run real Semgrep integration tests (requires Semgrep installed)
npm run test:openant   # Run real OpenAnt integration tests (requires OpenAnt + Python 3.11+)
npm run test:opencode  # Run real OpenCode integration tests (requires OpenCode installed)
npm run lint
npm run lint:fix       # Run ESLint with auto-fix
```

`npm run build-config` is the CLI users normally invoke as `aghast build-config`. It interactively edits `runtime-config.json` or accepts flags for scripted use — see [Runtime Configuration](configuration.md#runtime-configuration) for the full schema and flag list.

`npm run test:coverage` uses Node.js built-in test coverage support (`--experimental-test-coverage`) so contributors can measure coverage without adding a separate coverage toolchain.

The three `test:<tool>` scripts run real integration tests against external binaries and are **not** part of the default `npm test` suite — they require those tools installed locally. CI runs them in dedicated jobs.

## Releasing

A maintainer dispatches the release. Dispatching already requires write/admin access, so there is **no separate approval gate** — the one refinement over a plain push-to-`main` is that the stable version bump lands via an **auto-approved PR** rather than a direct push, so it counts as a reviewed changeset for Scorecard's Code-Review check.

1. Go to **Actions > Release > Run workflow**
2. Enter the new version (e.g. `1.2.0`). Must be semver, strictly greater than the current version. Optionally set `dry_run: true` to validate the whole flow (build, sign, `npm publish --dry-run`) without publishing — the dry-run PR and its branch are cleaned up automatically afterward.
3. The workflow validates the version, waits for CI on `main`, updates `package.json` and the install command in `docs/getting-started.md`, and opens a `release/v<version>` PR. The PR is opened by the release bot (`aghast-release-bot`, via `RELEASE_PR_TOKEN`), so CI runs on it and the `auto-approve` workflow — running as `github-actions[bot]`, a *different* identity — approves it. That non-author approval is the reviewed changeset the Scorecard Code-Review check counts. The PR is **bookkeeping — do not merge or close it manually**; the workflow does that itself.
4. Once the PR's checks pass, the workflow builds, signs, and publishes to npm (Trusted Publishing / OIDC), then merges the PR, tags the merged `main` commit `v<version>`, and creates a GitHub Release with the tarball attached.

Publishing happens **before** the merge on purpose: if `npm publish` fails, `main` is never advanced ahead of the registry, and the still-open PR can simply be closed.

### Release identity and tokens

All release git operations — branch push, PR open, merge, tag push — run as a single dedicated bot account, **`aghast-release-bot`** (repo `write`), through the **`RELEASE_PR_TOKEN`** secret. It must be a PAT (not `GITHUB_TOKEN`) so pushes and the PR trigger CI and the `auto-approve` workflow. No personal account token is involved. (The older `RELEASE_REVIEWER_TOKEN`/`RELEASE_PAT` secrets are no longer used and can be deleted.)

The token must grant, for this repository, both **Contents: write** (push the bump branch, push the tag, and merge) and **Pull requests: write** (open, close, and merge the bump PR). Repo `write` on the *account* is not sufficient on its own: a **fine-grained** PAT is further restricted to its own selected permissions, so it needs *Contents → Read and write* and *Pull requests → Read and write* explicitly — otherwise the branch push fails with `403 Permission … denied`. A **classic** PAT needs the `repo` scope.

The bump PR's non-author review comes from `github-actions[bot]` via `auto-approve.yml`; because it is a different identity from the bot that opened the PR, it is a valid approval and satisfies the Scorecard Code-Review check.

### Branch protection

Keep `main`'s branch protection enabled for everyone else — it still guards every other push (accidental or from a compromised token) against bypassing CI and review, which has nothing to do with the release flow. Rather than removing protection outright, add `aghast-release-bot` to the rule's **bypass list** (Settings > Branches > main > "Allow specified actors to bypass required pull requests"): this lets the bot merge its own auto-approved bump PR (its `github-actions[bot]` approval may not count toward a required-review rule) while `main` stays protected for every other push. Publish safety itself comes from publish-before-merge (a failed `npm publish` never advances `main`), not from branch rules — the bypass list only needs to cover the release bot's own merge step.

Do not rely on removing branch protection to "clear" an OpenSSF Scorecard Branch-Protection alert: that check generally scores *higher* when protections (required reviews, required status checks, no force-push) are present, so dropping protection entirely is more likely to lower the score than clear it. If a specific alert is about admins/bots being able to bypass required reviews, a scoped bypass list (above) addresses that directly without giving up the rest of the protection. Verify the actual before/after Scorecard output before treating branch-protection changes as a documented win.

If a release fixes a disclosed security vulnerability, update the generated GitHub Release notes to explicitly call out the fix. Include the CVE ID when one has been assigned.

## Prereleases

Prereleases (betas, release candidates) are published via the **same Release workflow** — it auto-detects prerelease vs stable from the input version format. Both paths share one workflow because npm Trusted Publishing authorizes exactly one workflow filename per package.

1. Go to **Actions > Release > Run workflow**
2. Enter a prerelease version in the form `x.y.z-<id>.<n>` (e.g. `0.5.0-beta.1`, `1.0.0-rc.2`, `0.5.0-alpha.3`). The base `x.y.z` must be strictly greater than the current stable version; `<id>` must be alphabetic (`beta` / `rc` / `alpha`); `<n>` is a numeric counter starting at `1`.
3. The workflow automatically:
   - Bumps `package.json` and `package-lock.json` in the runner only — `main` is **not** modified, so subsequent stable releases still see the current stable version as the base for the "strictly greater" check.
   - Creates and atomically pushes only the tag `v<version>` (the version-bump commit is reachable only through the tag).
   - Builds, packs, signs, and publishes to npm with `--tag <id>` (e.g. `--tag beta`). The default `latest` dist-tag is unaffected, so `npm install @owasp-aghast/aghast` continues to resolve to the stable release.
   - Creates a GitHub Release marked as **pre-release** so it doesn't appear as "Latest" on the releases page.

Users opt into a prerelease explicitly with `npm install -g @owasp-aghast/aghast@<id>` (e.g. `@beta`).

Shared build/sign/CI-wait steps used by both flows live under `.github/release-actions/`.

---

<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="configuration.md">&larr; Configuration Reference</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>
</p>
