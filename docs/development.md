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

Stable releases are gated on an explicit human approval delivered through the **`release` GitHub Environment**: the dispatched run *prepares* the release and then pauses at a deployment gate; publication happens only when a required reviewer approves it.

1. Go to **Actions > Release > Run workflow**
2. Enter the new version (e.g. `1.2.0`). Must be semver, strictly greater than the current version. Optionally set `dry_run: true` to validate the whole flow (build, sign, `npm publish --dry-run`) without publishing — the dry-run PR and its branch are cleaned up automatically afterward.
3. The `prepare` job validates the version, waits for CI on `main`, updates `package.json` and the install command in `docs/getting-started.md`, opens a `release/v<version>` PR, and waits for that PR's required checks to go green. The PR is opened by `RELEASE_PAT`, so the `auto-approve` workflow approves it and CI runs on it. The PR is **bookkeeping — do not merge or close it manually**; the workflow does that itself.
4. The `publish-stable` job then pauses on the **`release` environment gate**. A required reviewer approves the pending deployment via **Review deployments** on the workflow run (the person who dispatched the release may approve it). This — not the PR approval — is the control that authorizes publishing.
5. Once approved, `publish-stable` automatically:
   - Checks out the exact bump commit, re-verifies the version and that required checks are green
   - Builds, packs, and signs the tarball with cosign
   - Publishes to the npmjs registry (npm Trusted Publishing / OIDC)
   - Merges the release PR (**only after** npm publishing succeeds), then tags the merged `main` commit `v<version>`
   - Creates a GitHub Release with the tarball attached

Publishing happens **before** the merge on purpose: if `npm publish` fails, `main` is never advanced ahead of the registry, and the still-open PR can simply be closed.

### One-time setup: the `release` environment

The gate requires a GitHub Environment named **`release`** with a required reviewer. A maintainer creates it once, in either the UI or via the API:

- **UI:** **Settings > Environments > New environment > `release`**, then add **Required reviewers** (the maintainers who may authorize a publish). Leave *Prevent self-review* off if the sole maintainer needs to approve their own releases.
- **API** (adds the current user as reviewer):

  ```bash
  USER_ID=$(gh api users/tghosth --jq .id)
  gh api --method PUT repos/owasp-aghast/aghast/environments/release \
    -f "reviewers[][type]=User" -F "reviewers[][id]=$USER_ID"
  ```

Without this environment the `publish-stable` job runs unpaused, so the environment (with at least one reviewer) is what makes the gate real.

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
