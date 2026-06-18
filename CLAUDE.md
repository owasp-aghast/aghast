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
5. **Discovery Providers** — Pluggable target discovery system (`src/discovery.ts`): Semgrep, OpenAnt, and SARIF providers find code locations for targeted/static checks. Providers declare whether they support the cross-cutting diff filter step via `supportsDiffFilter`.
6. **Diff Filter** — Optional post-discovery transformation (`src/diff-filter.ts`) that narrows any SARIF-producing discovery's output to findings touching a git diff, using OpenAnt's call graph for flow-adjacency. Activated automatically when a diff source is provided; individual checks can opt out via `checkTarget.diffFilter: false`.
7. **Report Generator** — Produces `security_checks_results.json` (or `.sarif`) conforming to the `ScanResults` schema

**Scan workflow**: User initiates → repo metadata extracted → checks filtered for repo → for each check: load instructions (if applicable), run discovery (Semgrep, OpenAnt, or SARIF for targeted/static checks), optionally apply diff filter, AI analyzes (or map findings directly for static checks), results parsed → aggregate → JSON report → exit code.

**Check types**: Three check types with pluggable discovery:
- `repository` — AI analyzes the whole repo (no discovery needed)
- `targeted` — A discovery method finds specific code locations, AI analyzes each independently. Discovery methods: `semgrep` (Semgrep rules), `openant` (OpenAnt code units with call graph context), `sarif` (external SARIF file findings)
- `static` — A discovery method finds issues mapped directly to results, no AI involvement. Discovery methods: `semgrep`

Each targeted/static check specifies `checkTarget.discovery` (e.g., `semgrep`, `openant`, `sarif`) to select the discovery strategy. Targeted checks can also set `checkTarget.analysisMode` to control what the AI does with each target: `custom` (default, uses `instructionsFile`), `false-positive-validation`, or `general-vuln-discovery` (built-in prompt templates, no `instructionsFile` needed).

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
- `AGHAST_MOCK_SEMGREP=<path>` — Provide a SARIF file to use instead of running Semgrep (for testing targeted/static checks without Semgrep installed)
- `AGHAST_OPENANT_DATASET=<path>` — Provide a pre-generated OpenAnt dataset JSON file to use instead of invoking `openant parse`. Used for tests (so suites pass without OpenAnt installed) and supports production use cases like caching the dataset across runs or splitting OpenAnt into a separate CI job
- `AGHAST_SKIP_SEMGREP_TESTS=true` — Skip real Semgrep integration tests (used in CI main job; Semgrep tests run in a separate CI job)
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
- `npm run scan -- <repo-path> --config-dir <path> [--output <path>] [--output-format json|sarif] [--fail-on-check-failure] [--debug] [--log-level <level>] [--log-file <path>] [--log-type <type>] [--model <model>] [--agent-provider <name>] [--generic-prompt <file>] [--runtime-config <path>] [--diff-ref <ref>] [--diff-file <path>]` — Run checks (`--config-dir` required, default format: `json`, default output: `<repo-path>/security_checks_results.<ext>`, exit 1 on FAIL/ERROR with `--fail-on-check-failure`, `--debug` is shorthand for `--log-level debug`, `--log-file` writes all logs to a file at trace level). Discovery methods (Semgrep, OpenAnt, SARIF) are configured per-check via `checkTarget.discovery` in check definitions. Providing `--diff-ref`/`--diff-file`/`AGHAST_DIFF_REF` enables diff filtering on supporting discoveries automatically. Precedence: CLI flags > env vars > runtime config > defaults.
- `npm run new-check -- --config-dir <path> [--id <id> --name <name> ...]` — Interactive CLI to scaffold a new check (creates check folder with `<id>.json`, `<id>.md`, optional `<id>.yaml` Semgrep rule + tests; appends to `checks-config.json`). Bootstraps config directory if it doesn't exist.
- `npm run build-config -- --config-dir <path> [--non-interactive] [--provider <name>] [--model <id>] [--output-format json|sarif] [--log-level <level>] [--diff-ref <ref>] [--clear <field>] ...` — Build or edit `runtime-config.json`. Interactive when no value flags are given; non-interactive when `--non-interactive` is passed (or when all needed values come from flags). Loads existing config so omitted fields stay untouched. Models come from `provider.listModels()`: the Claude Code provider tries `@anthropic-ai/sdk` `models.list()` first when `ANTHROPIC_API_KEY` is set (full canonical list with display names), then falls back to `claude-agent-sdk` `supportedModels()` (curated 3 aliases — works with `AGHAST_LOCAL_CLAUDE=true`).

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
- `AGHAST_MOCK_SEMGREP` — Path to SARIF file for mock Semgrep output
- `AGHAST_OPENANT_DATASET` — Path to a pre-generated OpenAnt dataset JSON file (skips invoking `openant parse`)
- `AGHAST_DIFF_REF` — Git ref to diff against; enables diff filtering on supporting discoveries (CLI `--diff-ref` takes precedence)
- `AGHAST_HISTORY_FILE` — Override the scan history file path (default: `~/.aghast/history.json`)
- `AGHAST_MOCK_TOKENS` — Format `<input>,<output>`; injects token usage into the mock agent provider for cost/budget tests
- `AGHAST_MOCK_LOCAL_LOGIN` — Test hook for the Claude Code provider's local-login probe: `true` reports a logged-in session, `false` reports not-logged-in, both without spawning the agent SDK (keeps CLI auth tests hermetic)
- `AGHAST_DEBUG_PRINTPROMPT` — Print full prompts (requires `--debug`)
- `NO_COLOR` — Set to `1` to disable colored CLI output (standard; respected automatically by `picocolors`)

## Runtime Configuration

An optional `runtime-config.json` in the config directory (or via `--runtime-config`) sets defaults. See [docs/configuration.md](docs/configuration.md) for the full schema.

Precedence: CLI flags > environment variables > runtime config > built-in defaults.

## Key Files

- `src/cli.ts` — Unified CLI entry point with subcommand router (`scan`, `new-check`, `--help`, `--version`)
- `src/index.ts` — Scan CLI entry point and argument parsing (exports `runScan(args)`); validates config dir structure
- `src/scan-runner.ts` — Security Scanner orchestrator (`runMultiScan` for config-based multi-check; `executeTargetedCheck` for discovery-based checks with concurrent target analysis via `mapWithConcurrency`)
- `src/discovery.ts` — Pluggable discovery abstraction: `DiscoveryProvider` interface, `DiscoveryRegistry`, and discovery orchestration
- `src/discoveries/semgrep-discovery.ts` — Semgrep discovery provider (runs Semgrep rules, parses SARIF output into targets)
- `src/discoveries/openant-discovery.ts` — OpenAnt discovery provider (runs OpenAnt to extract code units with call graph context)
- `src/discoveries/sarif-discovery.ts` — SARIF discovery provider (reads external SARIF files for AI validation)
- `src/diff-filter.ts` — Diff filter (`applyDiffFilter`); called post-discovery whenever a diff source is available and the check hasn't opted out via `checkTarget.diffFilter: false`. Narrows targets to diff scope using OpenAnt call graph (depth-1), or falls back to file+line overlap (depth-0) when OpenAnt is unavailable
- `src/diff-parser.ts` — Unified diff parsing (`parseDiff`, `getDiff`, `loadDiffFromFile`)
- `src/diff-unit-matcher.ts` — Unit-to-diff matching with call graph traversal (`findTouchedUnits`, `filterFindingsByScope`)
- `src/claude-code-provider.ts` — Claude Code agent provider implementation using `@anthropic-ai/claude-agent-sdk`
- `src/opencode-provider.ts` — OpenCode agent provider implementation using `@opencode-ai/sdk` (supports 75+ LLM providers)
- `src/provider-utils.ts` — Shared provider utilities (OUTPUT_SCHEMA for structured output)
- `src/prompt-template.ts` — Prompt builder (prepends generic instructions to check markdown)
- `src/snippet-extractor.ts` — Code snippet extractor (extracts lines from source files for issue enrichment)
- `src/sarif-parser.ts` — SARIF 2.1.0 parser (`parseSARIF`, `deduplicateTargets`, `limitTargets`)
- `src/semgrep-runner.ts` — Semgrep execution with mock support (`runSemgrep`, `buildSemgrepArgs`)
- `src/openant-runner.ts` — OpenAnt execution with mock support (runs OpenAnt CLI, parses output)
- `src/openant-loader.ts` — OpenAnt dataset loading, unit filtering, and prompt formatting. Uses base datasets (`dataset.json`) not enhanced — the AI forms its own security judgment
- `src/check-types.ts` — Check type descriptor system; each check type (`repository`, `targeted`, `static`) declares its characteristics (needsAI, needsDiscovery, needsInstructions, etc.) in one place
- `src/check-library.ts` — Check Library: two-layer config loading (`loadCheckRegistry`, `loadCheckDefinition`, `discoverCheckFolders`, `resolveChecks`), validation, repository matching, markdown parsing, path filtering
- `src/repository-analyzer.ts` — Git metadata extraction (remote URL, branch, commit)
- `src/response-parser.ts` — AI response JSON parser
- `src/types.ts` — Shared type definitions (ScanResults, RepositoryInfo, SecurityIssue, etc.); includes `RuntimeConfig`
- `src/error-codes.ts` — Trackable error codes and formatting helpers (`formatError`, `formatFatalError`)
- `src/colors.ts` — Color helpers for CLI output (wraps `picocolors`, respects `NO_COLOR`)
- `src/logging.ts` — Pluggable logging system with standard levels (`error`, `warn`, `info`, `debug`, `trace`), `LogHandler` interface, `ConsoleHandler`, `FileHandler`, handler registry
- `src/runtime-config.ts` — Runtime configuration loader (`loadRuntimeConfig`); supports `--runtime-config` CLI flag
- `src/cost-calculator.ts` — Cost estimator: maps token usage to USD using `config/pricing.json` (mergeable with runtime-config `pricing` section)
- `src/scan-history.ts` — Persisted scan-history (`~/.aghast/history.json`): `saveScanRecord`, `queryScanHistory`. Tolerates corrupt files; falls back to `.aghast-history.json` when no homedir
- `src/budget.ts` — Budget controls: `checkBudget` (per-scan + per-period day/week/month limits) and `BudgetExceededError` (raised by scan-runner to abort)
- `src/stats.ts` — `aghast stats` subcommand (cost summary table from history)
- `config/pricing.json` — Built-in per-model pricing seed (Haiku/Sonnet/Opus)
- `src/new-check.ts` — Check scaffolding CLI utility (exports `runNewCheck(args)`); bootstraps config directory
- `src/build-config.ts` — Runtime-config builder CLI utility (exports `runBuildConfig(args)`); supports interactive + flag-driven modes, loads + edits existing files, validates against closed lists from provider/formatter/logging registries
- `src/formatters/index.ts` — Formatter registry
- `src/formatters/json-formatter.ts` — JSON output formatter
- `src/formatters/sarif-formatter.ts` — SARIF output formatter
- `src/formatters/types.ts` — Formatter type definitions
- `.github/workflows/release.yml` — Unified release workflow handling both stable (`x.y.z`) and prerelease (`x.y.z-<id>.<n>`) versions; auto-detects the flow from the input format
- `.github/release-actions/` — Composite actions used by `release.yml` (CI-wait polling, build/pack/sign)
- `eslint.config.js` — ESLint flat config (TypeScript + recommended rules)
- `config/prompts/` — Generic prompt templates prepended to all check executions (selected via `--generic-prompt` or `AGHAST_GENERIC_PROMPT`); includes `false-positive-validation.md` and `general-vuln-discovery.md` used when `analysisMode` is set in check definitions
- `docs/README.md` — Documentation index
- `docs/getting-started.md` — Getting started guide (installation, setup)
- `docs/trying-it-out.md` — Example checks walkthrough and first scan guide
- `docs/scanning.md` — Scan command reference (CLI options, env vars, output formats)
- `docs/creating-checks.md` — Creating checks reference (new-check CLI, what gets created)
- `docs/configuration.md` — Full configuration reference (check types, Layer 1/2 schemas, runtime config)
- `docs/development.md` — Development setup, building, testing, releasing
- `tests/` — All test files with fixtures in `tests/fixtures/`
- `tests/openant-integration.itest.ts` — Real OpenAnt integration tests (requires OpenAnt + Python 3.11+)

## Conventions

- **Error codes**: All CLI error paths must use codes from `src/error-codes.ts` via `formatError()`. Numbering scheme: E1xxx=CLI parsing, E2xxx=configuration, E3xxx=agent provider, E4xxx=repository/target validation, E5xxx=Semgrep, E6xxx=OpenAnt, E70xx=budget, E9xxx=internal/fatal.
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