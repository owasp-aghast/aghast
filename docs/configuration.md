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
      aghast-sqli.yaml        # Semgrep rule (for checks with semgrep discovery)
      tests/                  # Semgrep rule test files
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

Repository matching (for both `repositories` and `excludeRepositories`) uses bidirectional substring matching on normalized paths — so `"foo"` matches both `org/foo` and `org/foobar`. If the same string appears in both lists, exclusion wins.

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
| `checkTarget.discovery` | `string`                 | Yes***   | Discovery method: `semgrep`, `sarif`, or `openant` (***required for `targeted` and `static` types) |
| `checkTarget.analysisMode` | `string`              | No       | Analysis mode for targeted checks: `custom` (default), `false-positive-validation`, or `general-vuln-discovery`. Built-in modes use their own prompt template and don't require `instructionsFile`. See [How It Works](how-it-works.md) |
| `checkTarget.rules`| `string` or `string[]`        | Yes****  | Semgrep rule file path(s) relative to check folder (****only for `semgrep` discovery) |
| `checkTarget.sarifFile` | `string`                 | Yes***** | Path to SARIF file relative to target repository (*****only for `sarif` discovery) |
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
| `sarif` | SARIF file in check definition (`sarifFile`) | Reads findings from an external SARIF file | Yes |
| `openant` | OpenAnt + Python 3.11+ | Runs `openant parse` on the target repo to extract code units with call graph context | Yes |

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
    "outputFormat": "json"
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
| `reporting.outputFormat`        | `string`   | `json` | Output format: `json` or `sarif` |
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
| `pricing.currency`              | `string`   | `USD` | Currency for cost estimates |
| `pricing.models`                | `object`   | (built-in) | Per-model overrides: `{ "<model>": { "inputPerMillion": <usd>, "outputPerMillion": <usd> } }`. Merges with built-in defaults |

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
