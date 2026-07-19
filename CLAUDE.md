# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**aghast** — AI Guided Hybrid Application Static Testing. An automated security analysis system that uses LLMs to perform security audits on source code repositories. Licensed under GNU AGPL v3.

## Toolchain

- **Language**: TypeScript (Node.js)
- **Package Manager**: npm
- **AI SDK**: `@anthropic-ai/claude-agent-sdk`
- **Test Framework**: `node:test` with `node:assert` (Node.js built-in)

## Architecture

Seven core components orchestrated by the Security Scanner:

1. **Security Scanner** — Orchestrator that coordinates the scan workflow, executes checks, and aggregates results
2. **Check Library** — Two-layer config: loads check registry from `checks-config.json` (Layer 1: id, repositories, enabled) and per-check definitions from `checks/<id>/<id>.json` (Layer 2: name, instructions, severity, checkTarget) within a config directory specified via `--config-dir`. Merges layers, filters by repository, loads markdown instructions from each check folder.
3. **Agent Provider** — Abstraction layer over agent SDKs / harnesses that delegate to LLMs (reference impls: Claude Code, OpenCode)
4. **Repository Analyzer** — Extracts Git metadata (remote URL, branch, commit) from target repos
5. **Discovery Providers** — Pluggable target discovery system (`src/discovery.ts`): Semgrep, Opengrep, OpenAnt, SARIF, Glob and Script providers find code locations for targeted/static checks. Providers declare whether they support the cross-cutting diff filter step via `supportsDiffFilter`.
6. **Diff Filter** — Optional post-discovery transformation (`src/diff-filter.ts`) that narrows any SARIF-producing discovery's output to findings touching a git diff, using OpenAnt's call graph for flow-adjacency. Activated automatically when a diff source is provided; individual checks can opt out via `checkTarget.diffFilter: false`.
7. **Report Generator** — Produces `security_checks_results.json` (or `.sarif`) conforming to the `ScanResults` schema

**Scan workflow**: User initiates → repo metadata extracted → checks filtered for repo → for each check: load instructions (if applicable), run discovery (Semgrep, Opengrep, OpenAnt, or SARIF for targeted/static checks), optionally apply diff filter, AI analyzes (or map findings directly for static checks), results parsed → aggregate → JSON report → exit code.

**Check types**: Three check types with pluggable discovery:
- `repository` — AI analyzes the whole repo (no discovery needed)
- `targeted` — A discovery method finds specific code locations, AI analyzes each independently. Discovery methods: `semgrep` (Semgrep rules), `opengrep` (Opengrep rules — Semgrep fork, identical rule syntax), `openant` (OpenAnt code units with call graph context), `sarif` (external SARIF file findings), `glob` (file path pattern, whole-file targets), `script` (user-provided Node.js or bash script)
- `static` — A discovery method finds issues mapped directly to results, no AI involvement. Discovery methods: `semgrep`, `opengrep`

Each targeted/static check specifies `checkTarget.discovery` (e.g., `semgrep`, `opengrep`, `openant`, `sarif`) to select the discovery strategy. Targeted checks can also set `checkTarget.analysisMode` to control what the AI does with each target: `custom` (default, uses `instructionsFile`), `false-positive-validation`, or `general-vuln-discovery` (built-in prompt templates, no `instructionsFile` needed).

**Diff filtering**: Activates automatically on all discoveries (`semgrep`, `sarif`, `openant`) whenever a diff source is provided at scan time (`--diff-ref`, `--diff-file`, `AGHAST_DIFF_REF`, runtime config `diffRef`, or a check-level `diffRef`). OpenAnt is used for the call graph (depth-1 mode); if it's unavailable and no `AGHAST_OPENANT_DATASET` is provided, the filter falls back to depth-0 mode (file+line overlap only, no call-graph flow) with a clear warning log. Required strictly for `openant` discovery itself. Individual checks can opt out with `checkTarget.diffFilter: false`. When both discovery and filter need OpenAnt (e.g. an openant check with a diff source), the scan runner runs it once and shares the dataset.

## Key Data Flow

- Check instructions are markdown files prepended with a generic prompt template
- AI returns `{"issues": [...]}` JSON — parsed into `SecurityIssue[]`
- Issues enriched with `checkId`, `checkName`, `codeSnippet` by the scanner
- Final status per check: PASS (no issues), FAIL (issues found), ERROR (execution failed)

## Testing

- All tests use `node:test` and `node:assert` — no external test dependencies
- Agent provider must be mocked/stubbed in all tests — never depend on live API access
- Tests must pass without `ANTHROPIC_API_KEY` set
- Test fixtures live alongside tests: sample configs, markdown checks, AI responses, SARIF output
- GitHub Actions CI runs on push to main and all PRs
- The CLI supports `AGHAST_MOCK_AI=true` to use a mock agent provider (no API key needed), or `AGHAST_MOCK_AI=<path>` to supply a custom response fixture file
- `AGHAST_MOCK_SARIF=<path>` — Provide a SARIF file to use instead of running the configured SARIF-producing scanner (Semgrep or Opengrep). Bypasses the install prerequisite check for whichever tool the check targets. Test/development use only
- `AGHAST_OPENANT_DATASET=<path>` — Provide a pre-generated OpenAnt dataset JSON file to use instead of invoking `openant parse`. Used for tests (so suites pass without OpenAnt installed) and supports production use cases like caching the dataset across runs or splitting OpenAnt into a separate CI job
- `AGHAST_SKIP_SEMGREP_TESTS=true` — Skip real Semgrep integration tests (used in CI main job; Semgrep tests run in a separate CI job)
- `AGHAST_SKIP_OPENGREP_TESTS=true` — Skip real Opengrep integration tests (Opengrep tests run in a separate CI job)
- **When adding new functionality, always add CLI-level integration tests** in `tests/cli-mock-mode.test.ts` that spawn the real CLI process with `AGHAST_MOCK_AI=true`. These tests exercise the full pipeline (prompt building, response parsing, snippet extraction, issue enrichment, report generation) end-to-end. Include tests for PASS, FAIL, and ERROR scenarios as appropriate.

## CLI

The `aghast` binary provides subcommands:

- `aghast scan <repo-path> --config-dir <path> [options]` — Run security checks against a repository
- `aghast new-check --config-dir <path> [options]` — Scaffold a new security check (bootstraps config dir if needed)
- `aghast build-config --config-dir <path> [options]` — Build or edit `runtime-config.json` (interactive by default; `--non-interactive` plus field flags for scripted use; `--clear <field>` removes a field). Loads existing values if present so unspecified fields are preserved
- `aghast stats [options]` — Print a cost summary table from the local scan history (`~/.aghast/history.json`). Filter by `--repo`, `--model`, `--since`, `--until`; `--json` emits raw JSON
- `aghast --help` — Show usage
- `aghast --version` — Print version from package.json

The unified entry point is `src/cli.ts` which routes to `runScan()` (from `src/index.ts`), `runNewCheck()` (from `src/new-check.ts`), or `runBuildConfig()` (from `src/build-config.ts`). All three accept `args: string[]` and are exported for programmatic use.

## Commands

- `npm test` — Run all tests
- `npm run test:ci` — Run all tests with spec and JUnit reporters (for CI)
- `npm run test:semgrep` — Run real Semgrep integration tests (requires Semgrep installed)
- `npm run test:openant` — Run real OpenAnt integration tests (requires OpenAnt + Python 3.11+ installed)
- `npm run build` — Compile TypeScript
- `npm run lint` — Run ESLint on src/ and tests/
- `npm run lint:fix` — Run ESLint with auto-fix on src/ and tests/
- `npm run scan -- <repo-path> --config-dir <path> [--output <path>] [--output-format json|sarif|csv|html|markdown] [--fail-on-check-failure] [--debug] [--log-level <level>] [--log-file <path>] [--log-type <type>] [--model <model>] [--agent-provider <name>] [--generic-prompt <file>] [--runtime-config <path>] [--diff-ref <ref>] [--diff-file <path>]` — Run checks (`--config-dir` required, default format: `json`, default output: `<repo-path>/security_checks_results.<ext>`, exit 1 on FAIL/ERROR with `--fail-on-check-failure`, `--debug` is shorthand for `--log-level debug`, `--log-file` writes all logs to a file at trace level). Discovery methods (Semgrep, Opengrep, OpenAnt, SARIF) are configured per-check via `checkTarget.discovery` in check definitions. Providing `--diff-ref`/`--diff-file`/`AGHAST_DIFF_REF` enables diff filtering on supporting discoveries automatically. Precedence: CLI flags > env vars > runtime config > defaults.
- `npm run new-check -- --config-dir <path> [--id <id> --name <name> ...]` — Interactive CLI to scaffold a new check (creates check folder with `<id>.json`, `<id>.md`, optional `<id>.yaml` Semgrep rule + tests; appends to `checks-config.json`). Bootstraps config directory if it doesn't exist.
- `npm run build-config -- --config-dir <path> [--non-interactive] [--provider <name>] [--model <id>] [--output-format json|sarif|csv|html|markdown] [--log-level <level>] [--diff-ref <ref>] [--clear <field>] ...` — Build or edit `runtime-config.json`. Interactive when no value flags are given; non-interactive when `--non-interactive` is passed (or when all needed values come from flags). Loads existing config so omitted fields stay untouched. Models come from `provider.listModels()`: the Claude Code provider tries `@anthropic-ai/sdk` `models.list()` first when `ANTHROPIC_API_KEY` is set (full canonical list with display names), then falls back to `claude-agent-sdk` `supportedModels()` (curated 3 aliases — works with `AGHAST_LOCAL_CLAUDE=true`).

## Check Definitions (External)

Security check definitions and test codebases are maintained in a separate config directory (not in this repo). Use `--config-dir` to point the scanner at your checks:

```bash
npm run scan -- /path/to/target-repo --config-dir /path/to/checks-config
```

For local development, clone your checks repo as `checks-config/` (gitignored) inside this repo:

```bash
git clone <checks-repo-url> checks-config
npm run scan -- /path/to/target --config-dir checks-config
```

## Environment Variables

- `ANTHROPIC_API_KEY` — API key for the Claude Code agent provider. When unset, the provider falls back to a logged-in local Claude session (auto-detected via the agent SDK's `accountInfo()`); the scan errors only if neither an API key nor a logged-in local session is available
- `AGHAST_CONFIG_DIR` — Default config directory (CLI `--config-dir` takes precedence)
- `AGHAST_AI_MODEL` — AI model override (CLI `--model` takes precedence)
- `AGHAST_GENERIC_PROMPT` — Generic prompt template filename (CLI `--generic-prompt` takes precedence)
- `AGHAST_DEBUG` — Set to `true` to enable debug output (shorthand for `AGHAST_LOG_LEVEL=debug`)
- `AGHAST_LOG_LEVEL` — Console log level: `error`, `warn`, `info`, `debug`, `trace` (CLI `--log-level` takes precedence)
- `AGHAST_LOG_FILE` — Log file path (CLI `--log-file` takes precedence)
- `AGHAST_LOG_TYPE` — Log file handler type (CLI `--log-type` takes precedence, default: `file`)
- `AGHAST_LOCAL_CLAUDE` — Set to `true` to force local Claude mode, skipping both the API key and the login-detection probe (escape hatch / override)
- `AGHAST_MOCK_AI` — Enables mock agent provider. Set to `true` for default `{"issues":[]}` response, or set to a file path
- `AGHAST_MOCK_SARIF` — Path to SARIF file for mock Semgrep/Opengrep output (test/dev only)
- `AGHAST_OPENANT_DATASET` — Path to a pre-generated OpenAnt dataset JSON file (skips invoking `openant parse`)
- `AGHAST_DIFF_REF` — Git ref to diff against; enables diff filtering on supporting discoveries (CLI `--diff-ref` takes precedence)
- `AGHAST_HISTORY_FILE` — Override the scan history file path (default: `~/.aghast/history.json`)
- `AGHAST_MOCK_TOKENS` — Format `<input>,<output>`; injects token usage into the mock agent provider for cost/budget tests
- `AGHAST_MOCK_LOCAL_LOGIN` — Test hook for the Claude Code provider's local-login probe: `true` reports a logged-in session, `false` reports not-logged-in, both without spawning the agent SDK (keeps CLI auth tests hermetic)
- `AGHAST_MOCK_CLAUDE_MODELS` — Test hook for the Claude Code provider's supported-model list: comma-separated model IDs, used to keep CLI model-validation tests hermetic
- `AGHAST_DEBUG_PRINTPROMPT` — Print full prompts (requires `--debug`)
- `NO_COLOR` — Set to `1` to disable colored CLI output (standard; respected automatically by `picocolors`)

## Runtime Configuration

An optional `runtime-config.json` in the config directory (or via `--runtime-config`) sets defaults. See [docs/configuration.md](docs/configuration.md) for the full schema.

Precedence: CLI flags > environment variables > runtime config > built-in defaults.

## Key Files

**This list is deliberately not exhaustive.** It maps entry points and subsystem
boundaries — the things that are hard to infer by looking. Individual leaf files
are discoverable by glob and are intentionally omitted; please do not expand
this into a mirror of the filesystem, which drifts out of date faster than it
earns its keep. Where a directory's files are homogeneous, the directory is
listed instead of its contents.

**Entry points**

- `src/cli.ts` — Unified CLI entry point with subcommand router (`scan`, `new-check`, `build-config`, `stats`, `--help`, `--version`)
- `src/index.ts` — Scan entry point and argument parsing (exports `runScan(args)`); validates config dir structure
- `src/new-check.ts`, `src/build-config.ts`, `src/stats.ts` — The other three subcommands; each exports a `run*(args)` function and is usable programmatically

**Core scan pipeline**

- `src/scan-runner.ts` — Security Scanner orchestrator (`runMultiScan` for config-based multi-check; `executeTargetedCheck` for discovery-based checks with concurrent target analysis via `mapWithConcurrency`)
- `src/check-library.ts` — Check Library: two-layer config loading (`loadCheckRegistry`, `loadCheckDefinition`, `discoverCheckFolders`, `resolveChecks`), validation, repository matching, markdown parsing, path filtering
- `src/check-types.ts` — Check type descriptor system; each type (`repository`, `targeted`, `static`) declares its characteristics (needsAI, needsDiscovery, needsInstructions, etc.) in one place
- `src/types.ts` — Shared type definitions (`ScanResults`, `RepositoryInfo`, `SecurityIssue`, `RuntimeConfig`, …). `ScanMetadata` is deliberately a **closed** type — add explicit fields rather than widening it, so typos fail at compile time
- `src/ci-metadata.ts` — CI/CD pipeline detection (spec E.4): reads platform env vars for GitHub Actions, GitLab CI and CircleCI into `ScanResults.metadata.ciMetadata`. Read-only and never throws; adding a platform means adding one collector function

**Subsystems** — each is a registry plus interchangeable implementations; read the named file for the interface, then the sibling directory for the implementations

- `src/discovery.ts` + `src/discoveries/` — Pluggable target discovery: `DiscoveryProvider` interface, `DiscoveryRegistry`, orchestration. Implementations: semgrep, opengrep, openant, sarif, glob, script
- `src/formatters/index.ts` + `src/formatters/` — Output formatter registry and implementations (json, sarif, csv, html); `types.ts` defines the `OutputFormatter` interface
- `src/provider-registry.ts` + `src/*-provider.ts` — Agent providers (`claude-code-provider.ts`, `opencode-provider.ts`, `mock-agent-provider.ts`); `provider-utils.ts` holds the shared OUTPUT_SCHEMA
- `src/diff-filter.ts` — Diff filter (`applyDiffFilter`), applied post-discovery whenever a diff source exists and the check hasn't opted out via `checkTarget.diffFilter: false`. Narrows targets using the OpenAnt call graph (depth-1), falling back to file+line overlap (depth-0) when OpenAnt is unavailable. Supported by `diff-parser.ts` and `diff-unit-matcher.ts`
- `src/*-runner.ts` — External tool execution with mock support (semgrep, opengrep, openant). `semgrep-runner.ts` exports the shared `runSarifScanner`/`verifySarifScannerInstalled` helpers that `opengrep-runner.ts` delegates to
- `src/cost-calculator.ts`, `src/budget.ts`, `src/scan-history.ts` — Cost/budget subsystem: token→USD estimation from `config/pricing.json`, per-scan and per-period limits, and persisted history at `~/.aghast/history.json`
- `src/result-handlers/` — Post-scan delivery of findings to external systems. Currently `pr-comment-handler.ts` (GitHub PR inline review comments, spec E.7 Phase 1); issue trackers and notifications are the intended future siblings

**Design decisions worth knowing**

- `src/openant-loader.ts` — Uses **base** OpenAnt datasets (`dataset.json`), not enhanced ones, so the AI forms its own security judgment rather than inheriting OpenAnt's
- `src/error-codes.ts` — Trackable error codes and `formatError`/`formatFatalError`. See Conventions below for the numbering scheme
- `src/logging.ts` — Pluggable logging with standard levels and a `LogHandler` registry (`ConsoleHandler`, `FileHandler`)

**Config, docs and CI**

- `config/prompts/` — Generic prompt templates prepended to all check executions (selected via `--generic-prompt` / `AGHAST_GENERIC_PROMPT`); includes `false-positive-validation.md` and `general-vuln-discovery.md`, used when `analysisMode` is set
- `docs/` — User documentation; `docs/README.md` is the index and lists every page in order
- `.github/workflows/release.yml` — Unified stable + prerelease workflow (auto-detects the flow from the version format); composite steps live in `.github/release-actions/`
- `tests/` — All test files, fixtures in `tests/fixtures/`; `*.itest.ts` are real-tool integration tests requiring Semgrep/Opengrep/OpenAnt to be installed

## Conventions

- **Error codes**: All CLI error paths must use codes from `src/error-codes.ts` via `formatError()`. Numbering scheme: E1xxx=CLI parsing, E2xxx=configuration, E3xxx=agent provider, E4xxx=repository/target validation, E5xxx=Semgrep/Opengrep, E6xxx=OpenAnt, E70xx=budget, E71xx=script discovery, E72xx=result handlers (PR comments etc.), E9xxx=internal/fatal.
- **Color output**: Use helpers from `src/colors.ts` for colored output, never raw ANSI codes. The `NO_COLOR` env var is respected automatically via `picocolors`.

## Development Workflow

### Release Workflow

Releases (stable and prerelease) are created via the single `release.yml` GitHub Actions workflow (triggered manually via `workflow_dispatch`). The workflow auto-detects the flow from the version format — both paths live in one workflow because npm Trusted Publishing authorizes exactly one workflow filename per package.

**Stable release** — input `x.y.z` (e.g. `1.2.0`). Must be strictly greater than current. Workflow updates `package.json` + install command in `docs/getting-started.md`, commits to main, tags `v<version>`, builds, packs, publishes to npm under the default `latest` dist-tag, and creates a GitHub Release.

**Prerelease** — input `x.y.z-<id>.<n>` (e.g. `0.5.0-beta.1`). Base `x.y.z` must be strictly greater than current stable; `<id>` must be alphabetic (`beta` / `rc` / `alpha`); `<n>` must be `>= 1`. Workflow bumps `package.json` / `package-lock.json` in the runner only — `main` is NOT modified, so subsequent stable releases still see the current stable as the base for their strictly-greater check. Creates and atomically pushes only the tag `v<version>` (version-bump commit is reachable only through the tag). Publishes to npm with `npm publish --tag <id>`, leaving the `latest` dist-tag unchanged. Users opt in via `npm install @owasp-aghast/aghast@<id>`. GitHub Release is marked as pre-release.

Users install stable via `npm install -g @owasp-aghast/aghast@<version>` (requires `~/.npmrc` with `@owasp-aghast` scope config). Shared build/sign/CI-wait steps live in `.github/release-actions/`.

### Pull Request Titles (Release Notes)

The public repo generates GitHub Release notes from merged PR titles (`gh release create --generate-notes`), and squash-merge uses the PR title as the commit subject. **A PR title is therefore a public release-note line — write it as one:**

- Describe the user-facing change and its outcome, not the mechanism (and never the sync itself, e.g. no `chore: sync from private`).
- Imperative mood, specific, and self-contained — a reader skimming the release notes should understand it without opening the PR.
- Avoid bare verbs like `fix: fix bug`; say what was fixed.
- Prefix with a type (`feat` / `fix` / `docs` / `chore` / `ci`) so notes can be grouped by `.github/release.yml`.

We rely on this convention (and review) rather than a CI title linter — a linter enforces shape, not meaning.

## Documentation

Doc pages in `docs/` have navigation (index breadcrumb, previous/next links). When adding, removing, or reordering doc pages, update the navigation links in all affected pages and the index in `docs/README.md`. The page order is: How It Works → Getting Started → Trying It Out → Scanning → Creating Checks → Configuration Reference → Development.

## Licensing
This project is licensed under AGPL v3. Copyright (C) 2026 OWASP Foundation. Originally contributed by Bounce Consulting Ltd.

When setting up or modifying this repository:
- Ensure a `LICENSE` file exists in the root containing the full AGPLv3 license text
- Ensure `README.md` includes a ## License section with the AGPLv3 badge and link to LICENSE file
- If a new package.json, pyproject.toml, Cargo.toml, or similar manifest is created, ensure the license field is set to "AGPL-3.0-or-later"
- Do NOT add copyright headers to individual source files
