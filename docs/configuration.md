<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="creating-checks.md">&larr; Creating Checks</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="development.md">Development &rarr;</a>
</p>

---

# Configuration Reference

This document describes the full configuration schema for aghast security checks.

## Config Directory Structure

The config directory (specified via `--config-dir`) contains all check definitions and optional runtime configuration:

```
my-checks/
  checks-config.json          # Layer 1: which checks exist, per-repo filtering
  checks/
    aghast-xss/
      aghast-xss.json         # Layer 2: check definition (name, severity, type)
      aghast-xss.md           # AI instructions (not needed for static, openant, or sarif checks)
    aghast-sqli/
      aghast-sqli.json
      aghast-sqli.md
      aghast-sqli.yaml        # Semgrep/Opengrep rule (for semgrep or opengrep discovery)
      tests/                  # Semgrep/Opengrep rule test files
        aghast-sqli.py        # .py, .js, or .ts based on --language
  runtime-config.json          # (Optional) Agent provider & reporting overrides
```

Use `aghast new-check --config-dir <path>` to bootstrap this structure. If the directory doesn't exist, it will be created automatically.

## Layer 1: checks-config.json

The check registry controls which checks are available and which repositories they apply to.

```json
{
  "checks": [
    {
      "id": "aghast-xss",
      "repositories": ["https://github.com/org/frontend-app"],
      "enabled": true
    },
    {
      "id": "aghast-sqli",
      "repositories": [],
      "excludeRepositories": ["https://github.com/org/legacy-monolith"],
      "enabled": true
    }
  ]
}
```

| Field                 | Type       | Required | Description |
|-----------------------|------------|----------|-------------|
| `id`                  | `string`   | Yes      | Unique check ID (must match the check folder name) |
| `repositories`        | `string[]` | Yes      | Repository URLs this check applies to. Empty array `[]` means all repositories |
| `excludeRepositories` | `string[]` | No       | Repository URLs to skip for this check. Exclusion wins over inclusion. Useful with `"repositories": []` for "all repos except these" |
| `enabled`             | `boolean`  | No       | Set to `false` to disable a check (default: `true`) |
| `priority`            | `number`   | No       | Execution order. Non-negative integer; lower values run first. Checks without a priority sort to the end (stable order). Useful for running fast/cheap checks before expensive ones |
| `matchCriteria`       | `object`   | No       | Dynamic repository-matching rules. Evaluated *in addition* to `repositories` — an explicit repository match always wins; criteria can only ADD matches. See [Dynamic repository matching](#dynamic-repository-matching) below |

Repository matching (for both `repositories` and `excludeRepositories`) uses bidirectional substring matching on normalized paths — so `"foo"` matches both `org/foo` and `org/foobar`. If the same string appears in both lists, exclusion wins.

### Dynamic repository matching

Set `matchCriteria` on a Layer 1 entry to apply the check based on repository
characteristics rather than (or in addition to) an explicit `repositories`
list. Multiple criteria are AND'd together — a check matches when every
configured criterion matches the target repo.

```json
{
  "id": "aghast-typescript-only",
  "repositories": ["org/payments-api"],
  "matchCriteria": {
    "hasFileTypes": [".ts", ".tsx"],
    "hasFiles": ["package.json"],
    "hasPaths": ["src/api/**", "src/routes/**"],
    "tags": ["backend", "api-service"]
  }
}
```

This check runs on `org/payments-api` because it is listed explicitly, **and** on
any other repository satisfying every criterion: it contains at least one `.ts`
or `.tsx` file, has a `package.json`, has files under `src/api/` or `src/routes/`,
and is tagged both `backend` and `api-service`.

> **Do not pair `matchCriteria` with `"repositories": []`.** An empty
> `repositories` array already matches every repository, so the criteria can
> never narrow anything and the check runs everywhere — the opposite of what the
> config appears to say. Use a non-empty list, as above, or omit the explicit
> repositories you don't need and let the criteria do the selecting.

| Criterion       | Type       | Match when |
|-----------------|------------|------------|
| `hasFileTypes`  | `string[]` | The repo contains at least one file with one of the listed extensions (leading dot optional, e.g. `".ts"` or `"ts"`) |
| `hasFiles`      | `string[]` | EVERY listed entry exists. Each entry is matched as a literal repo-relative path first; if it contains glob metacharacters, falls back to glob (`picomatch`) |
| `hasPaths`      | `string[]` | At least one file in the repo matches at least one of the supplied glob patterns |
| `tags`          | `string[]` | EVERY listed tag appears in `<repo>/.aghast-tags` (newline-separated, `#` comments) and/or `<repo>/.aghast.json` `tags` array. Tag matching is **case-sensitive** — use the same casing in both files and your `matchCriteria.tags` |

**Notes**

- Explicit-list matches always win: if a check's `repositories` list matches
  the target repo, the check is included regardless of `matchCriteria`. Criteria
  only *add* matches.
- The repository filesystem walk skips a sensible default ignore list
  (`node_modules`, `.git`, `dist`, `build`, `.worktrees`, `.next`, `.nuxt`,
  `.venv`, `venv`, `__pycache__`, `target`, `coverage`). As a result,
  `hasFiles` / `hasPaths` cannot reference files inside these directories
  (e.g. `hasFiles: [".git/HEAD"]` will never match).
- The walk results are **cached** per repository for the duration of a scan,
  so multiple checks consulting `matchCriteria` for the same repo trigger
  the filesystem traversal only once. Successive programmatic invocations of
  `runScan` reset the cache so scans never reuse a stale snapshot.
- The walk is **bounded**: at most ~50,000 files and 12 levels of directory
  depth are inspected. On extremely large monorepos, files past the cap are
  not considered when evaluating `matchCriteria`. Run with `--debug` to see
  a log line if the cap is hit.
- `.aghast.json` is reserved for future aghast repo-level configuration. Today
  only its `tags` array is consumed by dynamic matching; other fields are
  ignored.
- An empty `matchCriteria` object (`{}`) is rejected by config validation —
  every populated `matchCriteria` must specify at least one of `hasFileTypes`,
  `hasFiles`, `hasPaths`, or `tags`.

## Layer 2: Check Definition (`<id>.json`)

Each check folder contains a JSON definition file with the check's metadata.

**Repository check** (AI analyzes the whole repo):

```json
{
  "id": "aghast-xss",
  "name": "XSS Prevention",
  "instructionsFile": "aghast-xss.md",
  "severity": "high",
  "confidence": "medium"
}
```

**Targeted check with Semgrep discovery** (Semgrep finds code locations, AI analyzes each):

```json
{
  "id": "aghast-sqli",
  "name": "SQL Injection",
  "instructionsFile": "aghast-sqli.md",
  "severity": "critical",
  "confidence": "high",
  "checkTarget": {
    "type": "targeted",
    "discovery": "semgrep",
    "rules": "aghast-sqli.yaml",
    "maxTargets": 50,
    "concurrency": 3
  }
}
```

**Static check with Semgrep discovery** (Semgrep findings mapped directly, no AI):

```json
{
  "id": "aghast-hardcoded-secrets",
  "name": "Hardcoded Secrets",
  "severity": "critical",
  "confidence": "high",
  "checkTarget": {
    "type": "static",
    "discovery": "semgrep",
    "rules": "aghast-hardcoded-secrets.yaml"
  }
}
```

Opengrep can be used as a drop-in replacement for Semgrep: change `discovery: "semgrep"` to `discovery: "opengrep"` in any check definition, and the rule file syntax remains identical. Opengrep is a community fork of Semgrep with the same CLI interface and SARIF output format.

**Targeted check with SARIF discovery** (external SARIF findings validated by AI):

```json
{
  "id": "aghast-sast-verify",
  "name": "SAST Finding Verification",
  "instructionsFile": "aghast-sast-verify.md",
  "severity": "high",
  "confidence": "medium",
  "checkTarget": {
    "type": "targeted",
    "discovery": "sarif",
    "sarifFile": "./example-findings.sarif"
  }
}
```

**Targeted check with glob discovery** (whole-file targets selected by file path pattern):

```json
{
  "id": "aghast-route-review",
  "name": "Route Handler Review",
  "instructionsFile": "aghast-route-review.md",
  "severity": "high",
  "confidence": "medium",
  "checkTarget": {
    "type": "targeted",
    "discovery": "glob",
    "glob": "src/routes/**/*.ts",
    "maxTargets": 50
  }
}
```

**Targeted check with OpenAnt discovery** (code units analyzed by AI):

```json
{
  "id": "aghast-openant-review",
  "name": "OpenAnt Security Review",
  "instructionsFile": "aghast-openant-review.md",
  "severity": "high",
  "confidence": "medium",
  "checkTarget": {
    "type": "targeted",
    "discovery": "openant",
    "maxTargets": 50,
    "concurrency": 3,
    "openant": {
      "securityClassifications": ["exploitable", "vulnerable_internal"],
      "excludeUnitTypes": ["test", "dunder_method"]
    }
  }
}
```

**Diff filtering activates whenever you supply a diff source.** You turn it on for a scan by providing a diff source — one of `--diff-ref`, `--diff-file`, `AGHAST_DIFF_REF`, runtime config `diffRef`, or a check-level `diffRef`. Once a diff source is present, every targeted check whose discovery supports it (`semgrep`, `sarif`) automatically has its findings narrowed to diff scope — no per-check field is required to opt in. The examples above run as diff-filtered scans in CI simply by passing `AGHAST_DIFF_REF`.

**Opting out a single check** when you otherwise want diff filtering on for the scan run:

```json
{
  "id": "aghast-supply-chain",
  "checkTarget": {
    "type": "targeted",
    "discovery": "semgrep",
    "rules": "aghast-supply-chain.yaml",
    "diffFilter": false
  }
}
```

Diff filtering works identically for `openant` discovery: the filter narrows the returned code units to those the diff touched (plus one call-graph hop). The OpenAnt invocation is shared between discovery and the filter so there's no double-run cost.

| Field              | Type                          | Required | Description |
|--------------------|-------------------------------|----------|-------------|
| `id`               | `string`                      | Yes      | Must match the Layer 1 registry ID and folder name |
| `name`             | `string`                      | Yes      | Human-readable check name |
| `instructionsFile`  | `string`                     | Yes*     | Markdown file with AI instructions (*not needed for `static` checks or `targeted` checks with a built-in `analysisMode`) |
| `severity`         | `string`                      | No       | `critical`, `high`, `medium`, `low`, or `informational` |
| `confidence`       | `string`                      | No       | `high`, `medium`, or `low` |
| `model`            | `string`                      | No       | AI model override for this check (e.g. `claude-sonnet-4-20250514`). Takes precedence over CLI `--model` and runtime config |
| `checkTarget`      | `object`                      | No       | Target configuration (omit for repository checks) |
| `checkTarget.type` | `string`                      | Yes**    | `repository`, `targeted`, or `static` (**required if `checkTarget` present) |
| `checkTarget.discovery` | `string`                 | Yes***   | Discovery method: `semgrep`, `opengrep`, `sarif`, `openant`, `glob`, or `script` (***required for `targeted` and `static` types) |
| `checkTarget.analysisMode` | `string`              | No       | Analysis mode for targeted checks: `custom` (default), `false-positive-validation`, or `general-vuln-discovery`. Built-in modes use their own prompt template and don't require `instructionsFile`. See [How It Works](how-it-works.md) |
| `checkTarget.rules`| `string` or `string[]`        | Yes****  | Rule file path(s) relative to check folder (****only for `semgrep` or `opengrep` discovery — both tools share the same rule syntax) |
| `checkTarget.sarifFile` | `string`                 | Yes***** | Path to SARIF file relative to target repository (*****only for `sarif` discovery) |
| `checkTarget.glob` | `string`                      | Yes****** | Glob pattern (e.g. `src/routes/**/*.ts`) relative to repository root (******only for `glob` discovery) |
| `checkTarget.maxTargets` | `number`               | No       | Limit number of targets/units to analyze |
| `checkTarget.concurrency` | `number`              | No       | Max parallel AI analyses for targeted checks (default: 5) |
| `checkTarget.diffFilter` | `boolean`              | No       | Set to `false` to skip diff filtering for this check even when a diff source is available. Default (omitted or `true`): filter automatically whenever a diff source is provided |
| `checkTarget.diffRef` | `string`                  | No       | Git ref to diff against for this check (e.g. `main`, `HEAD~1`). Lowest-priority diff source: overridden by `--diff-ref`, `AGHAST_DIFF_REF`, then runtime config `diffRef`. `--diff-file` bypasses all of these (including this field) and uses the diff file directly (CLI only, no `AGHAST_DIFF_FILE` env var) |
| `checkTarget.maxIssuesPerTarget` | `number`       | No       | Cap on issues returned per target. When set, only the first N entries of the AI's `issues` array are kept (excess dropped with a debug log). Use for checks whose prompt expects a single combined issue per target and where the model occasionally splits or duplicates findings. Omit for unlimited. |
| `checkTarget.openant` | `object`                  | No       | Config which filters OpenAnt units to be considered based on their metadata. Applies to both `openant` discovery and also when the diff filter is being used. See below for fields |
| `checkTarget.openant.unitTypes` | `string[]`       | No       | Include only these unit types (e.g. `["function", "method"]`) |
| `checkTarget.openant.excludeUnitTypes` | `string[]` | No      | Exclude these unit types (e.g. `["test", "dunder_method"]`) |
| `checkTarget.openant.securityClassifications` | `string[]` | No | Filter by OpenAnt classification (e.g. `["exploitable", "vulnerable_internal"]`) |
| `checkTarget.openant.reachableOnly` | `boolean`    | No       | Only include units reachable from entry points |
| `checkTarget.openant.entryPointsOnly` | `boolean`  | No       | Only include entry point units |
| `checkTarget.openant.minConfidence` | `number`     | No       | Minimum classification confidence (0-1) |
| `applicablePaths`  | `string[]`                    | No       | Glob patterns to include (e.g. `["src/**/*.ts"]`) |
| `excludedPaths`    | `string[]`                    | No       | Glob patterns to exclude (e.g. `["tests/**"]`) |
| `judge`            | `boolean`                     | No       | Set to `false` to exclude this check's issues from the LLM judge stage. Default (omitted or `true`): issues are judged when the judge stage is enabled |

## Check Types

| Type | AI Required? | Description |
|------|--------------|-------------|
| `repository` | Yes | AI analyzes the entire repository against the instructions |
| `targeted` | Yes | A discovery method finds specific code locations, AI analyzes each one |
| `static` | No | A discovery method finds code locations, findings are mapped directly to issues (no AI needed) |

### Discovery Methods

The `discovery` field on `checkTarget` specifies how targets are found for `targeted` and `static` checks:

| Discovery | Requires | Description | Supports diff filter |
|-----------|----------|-------------|----------------------|
| `semgrep` | Semgrep installed | Runs Semgrep rules to discover specific code locations | Yes |
| `opengrep` | Opengrep installed | Runs Opengrep (a Semgrep fork with identical rule syntax and SARIF output) — supports `targeted` and `static` check types | Yes |
| `sarif` | SARIF file in check definition (`sarifFile`) | Reads findings from an external SARIF file | Yes |
| `openant` | OpenAnt + Python 3.11+ | Runs `openant parse` on the target repo to extract code units with call graph context | Yes |
| `glob` | None | Walks the repository and selects whole-file targets matching a glob pattern (e.g. `src/routes/**/*.ts`). Targeted checks only. Always skips: `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.tox`, `.mypy_cache`, `.pytest_cache`, `dist`, `build`, `.next`, `.nuxt`, `.cache`, `.idea`, `.vscode`. Files larger than 10 MiB and symlinks are also skipped | No |
| `script` | None (script must be node or bash) | Runs a user-provided discovery script in the repo and parses its stdout into targets. Runs with `shell: false`, a curated environment with secrets stripped, a hard timeout and a bounded stdout. Script and output paths must resolve inside the repo, symlinks included | No |

### Diff filtering

Diff filtering narrows a SARIF-producing discovery's output to findings touching code in a git diff. A finding is "in scope" if it overlaps a code unit directly changed by the diff, or is a direct caller or callee of a changed unit (using OpenAnt's call graph). Findings in files OpenAnt can't parse (config files, templates) are kept if the file itself appears in the diff.

**Enabled automatically** whenever a diff source is provided and the check's discovery supports it. A diff source is either a pre-generated diff file (`--diff-file <path>`, CLI only) or a git ref — ref sources resolve in this precedence order:

1. CLI `--diff-ref <ref>`
2. Env var `AGHAST_DIFF_REF`
3. Runtime config `diffRef`
4. Check-level `checkTarget.diffRef`

`--diff-file` (CLI only) bypasses this entire chain when supplied — the file is used directly, no ref resolution.

If no diff source is set, checks run full-repo as usual — no filter, no error. To opt a specific check out of filtering even when a source is provided, set `checkTarget.diffFilter: false`.

Diff filtering uses OpenAnt for the call graph (depth-1 mode). If OpenAnt isn't installed and no `AGHAST_OPENANT_DATASET` is provided, the filter falls back to **depth-0 mode** — keep only findings whose file and line range overlap a diff hunk, no call-graph flow. aghast logs a clear warning when this happens so the mode is visible. Install OpenAnt (or supply a prebuilt dataset) to enable depth-1 filtering with caller/callee adjacency. Useful in PR/CI pipelines to focus analysis on changed code. See [Scanning → CI usage](scanning.md#ci-usage--diff-scoped-scans-on-prs) for GitHub Actions / GitLab CI recipes.

### Retry and resilience

**Retry is opt-in and off by default.** Without it, a transient provider failure — a dropped stream, a 5xx, a network reset — fails its check as it always has. Enable it, and those failures are retried with exponential backoff and jitter instead:

```bash
# CLI flag
aghast scan ./repo --config-dir ./checks --retry-max-attempts 3

# or environment variable
AGHAST_RETRY_MAX_ATTEMPTS=3 aghast scan ./repo --config-dir ./checks
```

```jsonc
// or runtime-config.json
{ "retry": { "maxAttempts": 3 } }
```

Precedence is the usual chain: `--retry-max-attempts` > `AGHAST_RETRY_MAX_ATTEMPTS` > `retry.maxAttempts` in runtime config. `maxAttempts` counts the first attempt, so `1` means no retry and `3` means the initial call plus two retries. Three is a reasonable starting point for unattended CI runs, where a transient failure would otherwise mean re-running the whole scan.

Errors that have already been classified as terminal are **never** retried, regardless of these settings:

- `FatalProviderError` — quota exhaustion and authentication failures. The provider raises this for messages like *"you've hit your limit"*; a subscription limit resets on a schedule, not in seconds, so retrying only burns the remaining attempts.
- Budget aborts — the scan has spent what it was allowed to spend.

A single circuit breaker is shared across the whole scan **when retry is enabled**. Once `retry.circuitBreakerThreshold` consecutive transient failures have occurred anywhere, retrying stops for the remainder of the run: if the provider is failing repeatedly then every remaining target will fail too, and retrying each one wastes both wall-clock time and quota. With retry off there are no retries to stop, so no breaker is created and every failure surfaces as its original error.

Two caveats worth knowing before enabling it:

- The per-target timeout is classified as retryable, so `maxAttempts: 3` can take up to roughly three times as long to give up on a genuinely hung provider.
- The [judge stage](scanning.md#llm-judge-stage) makes its own AI calls, and they are covered by the same setting — enabling retry covers judging too.

## Check Instructions (`<id>.md`)

The markdown file contains instructions for the AI. It is prepended with a generic prompt template before being sent. A typical structure:

```markdown
### Check Name

#### Overview
What this check looks for and why it matters.

#### What to Check
1. First thing to verify
2. Second thing to verify

#### Result
- **PASS**: When the code meets requirements
- **FAIL**: When the code has issues
- **FLAG**: When human review is needed (optional)
```

## Check Result Statuses

| Status | Meaning |
|--------|---------|
| `PASS` | No issues found. The code meets the check requirements |
| `FAIL` | Issues found. The code does not meet the check requirements |
| `FLAG` | AI is uncertain. Human review is recommended |
| `ERROR` | The check could not be completed (e.g. agent provider error) |

When multiple targets are analyzed, the overall status is the worst: FAIL > FLAG > ERROR > PASS.

## Creating New Checks

Use the scaffolding CLI to create a new check in your config directory:

```bash
aghast new-check --config-dir /path/to/your-checks
```

If the config directory doesn't exist, it will be created with an empty registry. Run `aghast new-check --help` for all available flags.

## Runtime Configuration

An optional `runtime-config.json` file in the config directory (or specified via `--runtime-config`) sets defaults for scan options. All fields are optional. If the file is absent, built-in defaults are used.

```json
{
  "agentProvider": {
    "name": "claude-code",
    "model": "claude-sonnet-4-20250514"
  },
  "reporting": {
    "outputDirectory": "/path/to/results",
    "outputFormat": "json",
    "includeIndividualIssueFiles": false,
    "individualIssueFormat": "markdown"
  },
  "logging": {
    "logFile": "/path/to/scan.log",
    "logType": "file",
    "level": "info"
  },
  "genericPrompt": "generic-instructions.md",
  "failOnCheckFailure": false,
  "diffRef": "main",
  "budget": {
    "perScan": { "maxCostUsd": 5.00, "maxTokens": 10000000 },
    "perPeriod": { "window": "day", "maxCostUsd": 25.00 },
    "thresholds": { "warnAt": 0.8, "abortAt": 1.0 }
  },
  "pricing": {
    "currency": "USD",
    "models": {
      "my-custom-model": { "inputPerMillion": 2.0, "outputPerMillion": 8.0 }
    }
  },
  "judge": {
    "model": "claude-opus-4-7",
    "provider": "claude-code",
    "concurrency": 5,
    "dropFalsePositives": true,
    "minConfidence": 0.7
  }
}
```

### Budget controls

When `budget` is set, the scan runner evaluates the limit before each AI call:

- **`continue`** — under the warn threshold, the scan proceeds silently.
- **`warn`** — at or above `thresholds.warnAt` (default 80%), a warning is logged once.
- **`abort`** — at or above `thresholds.abortAt` (default 100%), the scan stops. The remaining checks are recorded as ERROR and the CLI exits non-zero.

The `--budget-limit-cost <usd>` and `--budget-limit-tokens <n>` CLI flags override `budget.perScan` for a single scan.

The `perPeriod` limit aggregates cost across historical scans (from `~/.aghast/history.json`) plus the in-flight scan. The window starts at midnight UTC for `day`, Monday 00:00 UTC for `week`, or the first of the month for `month`.

### Pricing

The built-in `config/pricing.json` provides per-million-token rates for the default Claude models. Add or override entries via `runtime-config.json`'s `pricing.models` section. Costs are estimates only — provider prices change over time.

| Field                           | Type       | Default | Description |
|---------------------------------|------------|---------|-------------|
| `agentProvider.name`            | `string`   | `claude-code` | Agent provider name (`claude-code` or `opencode`) |
| `agentProvider.model`           | `string`   | (provider default) | Model ID override. For `opencode`, use `providerID/modelID` format (e.g. `opencode/nemotron-3-super-free`) |
| `reporting.outputDirectory`     | `string`   | (target repo) | Directory for result files |
| `reporting.outputFormat`        | `string`   | `json` | Output format: `json`, `sarif`, `csv`, `html`, or `markdown` (see [Scanning › Output Formats](scanning.md#output-formats)) |
| `reporting.includeIndividualIssueFiles` | `boolean` | `false` | When `true`, write one file per issue under `security_issues_<project>/<check-id>/` alongside the main report (Spec E.3.2). The directory is created in the same folder as the main report. Each run first removes `issue_<NNN>_*` files left by the previous run, so a scan with fewer findings does not leave stale ones behind; files you add yourself are not touched |
| `reporting.individualIssueFormat` | `string` | `markdown` | Format for individual issue files: `markdown`, `json`, or `html`. Ignored unless `includeIndividualIssueFiles` is `true` |
| `logging.logFile`               | `string`   | (none) | Path to log file. When set, all log output is written to this file |
| `logging.logType`               | `string`   | `file` | Log file handler type. Pluggable; currently only `file` is supported |
| `logging.level`                 | `string`   | `info` | Console log level: `error`, `warn`, `info`, `debug`, `trace` |
| `genericPrompt`                 | `string`   | `generic-instructions.md` | Generic prompt template filename |
| `failOnCheckFailure`            | `boolean`  | `false` | Exit with code 1 if any check FAILs or ERRORs |
| `diffRef`                       | `string`   | (none) | Git ref to diff against. Auto-activates diff filtering on every check whose discovery supports it, unless the check opts out via `diffFilter: false`. CLI `--diff-ref` takes precedence |
| `budget.perScan.maxTokens`      | `number`   | (none) | Abort scan when accumulated tokens exceed this value |
| `budget.perScan.maxCostUsd`     | `number`   | (none) | Abort scan when accumulated cost exceeds this USD value |
| `budget.perPeriod.window`       | `string`   | (none) | `day`, `week`, or `month` window for the period limit |
| `budget.perPeriod.maxCostUsd`   | `number`   | (none) | Abort when total cost across the period (history + current scan) exceeds this USD value |
| `budget.thresholds.warnAt`      | `number`   | `0.8` | Fraction of a limit at which a warning is logged (0.0–1.0) |
| `budget.thresholds.abortAt`     | `number`   | `1.0` | Fraction of a limit at which the scan aborts (0.0–1.0) |
| `retry.maxAttempts`             | `number`   | `1` | Total attempts per AI call, including the first. `1` disables retry; set `>1` to opt in. Applies to transient provider failures only |
| `retry.baseDelayMs`             | `number`   | `1000` | Initial backoff before jitter |
| `retry.maxDelayMs`              | `number`   | `16000` | Cap on backoff before jitter |
| `retry.circuitBreakerThreshold` | `number`   | `5` | Consecutive transient failures across the whole scan before retrying stops. Shared by every check and target |
| `pricing.currency`              | `string`   | `USD` | Currency for cost estimates |
| `pricing.models`                | `object`   | (built-in) | Per-model overrides: `{ "<model>": { "inputPerMillion": <usd>, "outputPerMillion": <usd> } }`. Merges with built-in defaults |

| `judge.model`               | `string`   | (none, stage disabled) | Enable the LLM judge stage using this model. The judge re-evaluates every finding post-scan and annotates it with a verdict, confidence, and rationale. CLI `--judge-model` takes precedence |
| `judge.provider`            | `string`   | (scan provider) | Agent provider for the judge stage. Defaults to the scan provider if omitted |
| `judge.concurrency`         | `number`   | `5` | Max parallel judge calls per scan |
| `judge.dropFalsePositives`  | `boolean`  | `false` | Remove issues confirmed as false positives from the output. If a check loses all its issues, it becomes PASS |
| `judge.minConfidence`       | `number`   | (none) | Confidence threshold (0–1). `true_positive` verdicts below this value are demoted to `uncertain` |

**Precedence**: CLI flags > environment variables > runtime config > built-in defaults.

If the file is present but contains invalid JSON, the CLI exits with an error.

### Building a runtime config

Use `aghast build-config` to create or edit `runtime-config.json` interactively:

```bash
aghast build-config --config-dir ./my-checks
```

The command loads an existing file (if present) so unspecified fields are preserved. You choose providers and models from a closed list — what's available depends on the provider and your auth (e.g. the Claude Code provider returns more models when `ANTHROPIC_API_KEY` is set than under local-Claude auth).

Pass `--non-interactive` plus value flags for scripted use, or `--clear <field>` to remove a field:

```bash
aghast build-config --config-dir ./my-checks --non-interactive \
  --provider claude-code --model sonnet --output-format sarif

aghast build-config --config-dir ./my-checks --clear logFile
```

Run `aghast build-config --help` for the full flag list.

---

<p align="center">
  <a href="creating-checks.md">&larr; Creating Checks</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="development.md">Development &rarr;</a>
</p>
