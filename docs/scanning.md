<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="trying-it-out.md">&larr; Trying It Out</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="cost-tracking.md">Cost Tracking &rarr;</a>
</p>

---

# Scanning

Run security checks against a target repository.

## Usage

```bash
aghast scan <repo-path> --config-dir <path> [options]
```

| Option | Description |
|--------|-------------|
| `--config-dir <path>` | **(Required)** Config directory containing `checks-config.json` and `checks/` folder |
| `--output <path>` | Output file path (default: `<repo-path>/security_checks_results.<ext>`) |
| `--output-format json\|sarif` | Output format (default: `json`) |
| `--fail-on-check-failure` | Exit with code 1 if any check FAILs or ERRORs |
| `--debug` | Shorthand for `--log-level debug` |
| `--log-level <level>` | Console log level: `error`, `warn`, `info`, `debug`, `trace` (default: `info`) |
| `--log-file <path>` | Write all log output to a file (captures at `trace` level by default) |
| `--log-type <type>` | Log file handler type (default: `file`). Pluggable; new types can be added |
| `--model <model>` | AI model override (e.g. `claude-sonnet-4-20250514`) |
| `--agent-provider <name>` | Agent provider name (default: `claude-code`) |
| `--generic-prompt <file>` | Generic prompt template filename |
| `--runtime-config <path>` | Path to runtime config file. Useful for setting persistent defaults instead of repeating CLI flags |
| `--diff-ref <ref>` | Git ref to diff against (e.g. `HEAD~1`, `main`, a commit SHA). Enables diff filtering on supporting discoveries |
| `--diff-file <path>` | Path to pre-generated unified diff file (alternative to `--diff-ref`) |
| `--budget-limit-cost <usd>` | Abort the scan when accumulated cost exceeds this USD value (warns at 80%) |
| `--budget-limit-tokens <n>` | Abort the scan when accumulated tokens exceed this count (warns at 80%) |

Run `aghast scan --help` for the full list of options.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Claude (required for AI-based checks with the `claude-code` provider) |
| `AGHAST_CONFIG_DIR` | Default config directory (CLI `--config-dir` takes precedence) |
| `AGHAST_AI_MODEL` | AI model override (CLI `--model` takes precedence) |
| `AGHAST_GENERIC_PROMPT` | Generic prompt template filename (CLI `--generic-prompt` takes precedence) |
| `AGHAST_DEBUG` | Set to `true` to enable debug output (same as `--debug`) |
| `AGHAST_LOG_LEVEL` | Console log level (CLI `--log-level` takes precedence) |
| `AGHAST_LOG_FILE` | Log file path (CLI `--log-file` takes precedence) |
| `AGHAST_LOG_TYPE` | Log file handler type (CLI `--log-type` takes precedence) |
| `AGHAST_MOCK_SEMGREP` | Path to a SARIF file to use instead of running Semgrep (for testing `semgrep` discovery without Semgrep installed) |
| `AGHAST_OPENANT_DATASET` | Path to a pre-generated OpenAnt dataset JSON file. When set, aghast uses this dataset directly instead of invoking `openant parse`. Useful for caching the dataset across multiple scans, splitting OpenAnt and aghast into separate CI jobs, running aghast where Python 3.11+ isn't available, or stubbing OpenAnt output in tests |
| `AGHAST_DIFF_REF` | Git ref to diff against; enables diff filtering on supporting discoveries (CLI `--diff-ref` takes precedence) |
| `NO_COLOR` | Set to `1` to disable colored CLI output ([standard](https://no-color.org/)) |

## Agent Providers

aghast supports multiple agent providers via the `--agent-provider` flag or `agentProvider.name` in runtime config.

| Provider | `--agent-provider` | `--model` format | Prerequisites |
|----------|--------------------|------------------|---------------|
| Claude Code (default) | `claude-code` | Model name (e.g. `haiku`, `sonnet`) | `ANTHROPIC_API_KEY` env var |
| OpenCode | `opencode` | `providerID/modelID` (e.g. `opencode/nemotron-3-super-free`, `cursor-acp/composer-2-fast`) | [OpenCode CLI](https://opencode.ai) installed and configured |

### Using OpenCode

[Click for a video introduction to OpenCode support.](https://youtu.be/NkOc6pLanmQ)

The OpenCode provider delegates to any of the 75+ LLM providers supported by [OpenCode](https://opencode.ai). To use it:

1. Install OpenCode: follow the instructions at https://opencode.ai
2. Configure a provider: run `opencode` and use `/connect` to set up credentials
3. Run a scan:
   ```bash
   aghast scan ./my-repo --config-dir ./checks --agent-provider opencode --model opencode/nemotron-3-super-free
   ```

The default model is `opencode/nemotron-3-super-free`. Use the `providerID/modelID` format to select any configured provider and model.

## Runtime Configuration

An optional `runtime-config.json` in the config directory (or specified via `--runtime-config`) sets defaults for scan options. See the [Configuration Reference](configuration.md#runtime-configuration) for the full schema.

**Precedence**: CLI flags > environment variables > runtime config > built-in defaults.

## Output Formats

Results are written to `security_checks_results.<ext>` in the target repo by default (override with `--output`).

- **JSON** (default) - structured results with summary, per-check details, issues, and token usage
- **SARIF** - SARIF 2.1.0 output compatible with GitHub Code Scanning and other SARIF viewers

## Check Types

aghast supports three check types with pluggable discovery methods:

| Type | AI? | Description |
|------|-----|-------------|
| `repository` | Yes | AI analyzes the entire repository against markdown instructions |
| `targeted` | Yes | A discovery method finds specific code locations, AI analyzes each one independently |
| `static` | No | A discovery method finds code locations, findings are mapped directly to issues (no AI needed, no API key needed) |

Discovery methods for `targeted` and `static` checks:

| Discovery | Requires | Description | Supports `diffFilter` |
|-----------|----------|-------------|-----------------------|
| `semgrep` | Semgrep installed | Runs Semgrep rules to discover specific code locations | Yes |
| `sarif` | SARIF file in check definition | Reads findings from an external SARIF file | Yes |
| `openant` | OpenAnt + Python 3.11+ | Runs `openant parse` on the target repo to extract code units with call graph context | Yes |

Diff filtering narrows findings to code touched by a git diff (plus call-graph flow). It activates automatically on all supporting discoveries whenever you provide a diff source (`--diff-ref`, `--diff-file`, `AGHAST_DIFF_REF`, or a check-level `diffRef`). OpenAnt (used for the call graph) is optional: if it isn't installed and no `AGHAST_OPENANT_DATASET` is provided, the filter falls back to **depth-0 mode** — file and line overlap only, no call-graph flow. A warning is logged when the fallback triggers. Set `checkTarget.diffFilter: false` on a specific check to exempt it. See [How It Works](how-it-works.md#diff-filtering-narrowing-a-discovery-to-changed-code) for details.

Analysis modes for `targeted` checks (`checkTarget.analysisMode`):

| Mode | Discovery | Description |
|------|-----------|-------------|
| `custom` (default) | All | AI analyzes each target using your custom instructions markdown file |
| `false-positive-validation` | `semgrep`, `sarif` | AI validates each finding as a true or false positive |
| `general-vuln-discovery` | All | AI scans each target for a broad range of security vulnerabilities |

Built-in modes (`false-positive-validation`, `general-vuln-discovery`) provide their own prompt template and don't require an instructions file. See [How It Works](how-it-works.md#three-check-types) for details.

See the [Configuration Reference](configuration.md) for check definition schemas and result statuses.

## CI usage — diff-scoped scans on PRs

For PR/MR pipelines you typically want to scan only the code touched by the change. Set `AGHAST_DIFF_REF` (or pass `--diff-ref`) to the base branch of the PR/MR at scan time — diff filtering activates automatically on every check whose discovery supports it. The check configs require no changes. Any individual check that should stay full-repo even during PR scans can set `checkTarget.diffFilter: false` in its definition.

**Important:** the default CI checkout is usually shallow (depth 1), which stops `git diff` from seeing the base. Disable shallow cloning or fetch the base branch explicitly before running the scan. Settings: GitHub Actions `fetch-depth: 0` on the checkout action; GitLab CI `GIT_DEPTH: "0"` as a job variable (plus an explicit `git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"` since GitLab's shallow clone doesn't pull the target branch even at full depth).

### Diff-ref value per platform

| Platform | `AGHAST_DIFF_REF` value |
|---|---|
| GitHub Actions (`pull_request`) | `origin/${{ github.base_ref }}` |
| GitLab CI (merge request pipeline) | `origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME` |

### When to use `--diff-file` instead

Use `--diff-file <path>` when your pipeline already produces a unified diff on disk (e.g. `gh pr diff --patch > pr.diff`) and you'd rather pass that than have aghast re-run `git diff` internally. For most CI workflows `AGHAST_DIFF_REF` is simpler and needs no intermediate step.

## Cost dashboards (`aghast stats`)

Each successful scan appends a record to the local history file (`~/.aghast/history.json` by default) with token usage, estimated cost, models, duration, and per-repository metadata. The `aghast stats` subcommand summarises that history:

```bash
aghast stats                          # full summary
aghast stats --repo my-org/repo       # filter by repository (substring)
aghast stats --model claude-sonnet    # filter by model substring
aghast stats --since 2026-01-01       # only include scans started on/after this timestamp
aghast stats --json                   # raw JSON for piping to jq / spreadsheets
```

Costs are estimates derived from `config/pricing.json` (Anthropic per-million-token rates for Haiku / Sonnet / Opus). Override or extend the pricing in your runtime config — see the [Configuration Reference](configuration.md#pricing).

Set the `AGHAST_HISTORY_FILE` env var (or pass `--history-file` to `aghast stats`) to use a different file — useful for shared CI dashboards.

## Budget controls

Use `--budget-limit-cost <usd>` and `--budget-limit-tokens <n>` to cap a single scan, or persist limits in `runtime-config.json`'s `budget` section (including per-day / week / month aggregation against historical scans). When usage hits 80% of any limit a warning is logged; at 100% the scan aborts and remaining checks are recorded as ERROR. See the [Configuration Reference](configuration.md#budget-controls) for the full schema.

---

<p align="center">
  <a href="trying-it-out.md">&larr; Trying It Out</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="creating-checks.md">Creating Checks &rarr;</a>
</p>
