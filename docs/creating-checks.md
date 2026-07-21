<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="cost-tracking.md">&larr; Cost Tracking</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="configuration.md">Configuration Reference &rarr;</a>
</p>

---

# Creating Checks

Scaffold new security checks using the `aghast new-check` CLI.

## Usage

```bash
aghast new-check --config-dir <path> [options]
```

Scaffolds a new security check interactively. Any values not provided via flags are prompted for. If the config directory doesn't exist, it will be created with an empty registry.

| Option | Description |
|--------|-------------|
| `--config-dir <path>` | **(Required)** Config directory to create the check in |
| `--id <id>` | Check ID (auto-prefixed with `aghast-` if needed) |
| `--name <name>` | Human-readable check name |
| `--check-type <type>` | `repository` (default), `targeted`, or `static` |
| `--discovery <method>` | Discovery method: `semgrep`, `opengrep`, `sarif`, `openant`, `glob`, or `script` (required for `targeted` and `static` types; `sarif`, `openant`, `glob`, and `script` are targeted-only) |
| `--analysis-mode <mode>` | Analysis mode for targeted checks: `custom` (default), `false-positive-validation`, or `general-vuln-discovery` |
| `--script <path>` / `--script-type <type>` / `--output-format <format>` | For `script` discovery: the script path (relative to the check folder; omit to generate a starter script), the runtime (`node` or `bash`), and the stdout format (`lines`, `json-array`, or `json-object`). See [Script discovery](configuration.md#script-discovery) |
| `--priority <n>` | Execution order (non-negative integer; lower runs first, unset runs last) |
| `--match-file-types` / `--match-paths` / `--match-files` / `--match-tags` | `matchCriteria` sub-fields — dynamically match repositories in addition to the explicit `--repositories` list. See [Repository matching](configuration.md#dynamic-repository-matching) |
| `--severity <level>` | `critical`, `high`, `medium`, `low`, or `informational` |
| `--confidence <level>` | `high`, `medium`, or `low` |

Run `aghast new-check --help` for the full list of flags including `--check-overview`, `--check-items`, `--pass-condition`, `--fail-condition`, `--flag-condition`, `--repositories`, `--semgrep-rules` / `--opengrep-rules` (aliases for the same flag — don't pass both in the same command), `--max-targets`, `--language`, `--cwd`, and `--timeout-ms`.

## What gets created

Running `new-check` creates a check folder in `<config-dir>/checks/<check-id>/` containing:

- `<id>.json` - check definition (name, severity, type, discovery method, target config)
- `<id>.md` - markdown instructions for AI analysis (not created for `static` checks or targeted checks using a built-in analysis mode)
- `<id>.yaml` - Semgrep/Opengrep rule file (for checks with `semgrep` or `opengrep` discovery — both tools share the same rule syntax)
- `tests/` - Semgrep/Opengrep rule test files (for checks with `semgrep` or `opengrep` discovery)
- `<id>.js` / `<id>.sh` - starter discovery script (for `script` discovery, when you don't point `--script` at an existing file). It documents the output contract in comments and prints an empty target set — edit it before running. See [Script discovery](configuration.md#script-discovery) for the trust model and output formats

The check is also registered in `checks-config.json`. When you provide `--priority` or any `--match-*` flag, the registry entry also gets `priority` / `matchCriteria` (both Layer 1 fields).

## Check definition schema

See the [Configuration Reference](configuration.md#layer-2-check-definition-idjson) for the full check definition schema, including check types, severity levels, Semgrep target configuration, and path filtering.

## Diff filtering

Every targeted/static check whose discovery supports it (`semgrep`, `opengrep`, `sarif`, `openant`) automatically participates in [diff filtering](configuration.md#diff-filtering) when the scan is invoked with a diff source (e.g. `--diff-ref`, `AGHAST_DIFF_REF` in a PR workflow) — nothing in the check JSON is required to opt in. `glob` and `script` discovery do not support diff filtering (`checkTarget.diffFilter` has no effect for them) and always run full-repo. If a specific check with a supporting discovery should stay full-repo even during a diff-scoped scan, set `"diffFilter": false` on its `checkTarget`. See the [Configuration Reference](configuration.md#diff-filtering) for details.

---

<p align="center">
  <a href="scanning.md">&larr; Scanning</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="configuration.md">Configuration Reference &rarr;</a>
</p>
