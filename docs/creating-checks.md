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
| `--discovery <method>` | Discovery method: `semgrep`, `opengrep`, `sarif`, `openant`, or `glob` (required for `targeted` and `static` types; `sarif`, `openant` and `glob` are targeted-only). `script` discovery is not scaffolded — write the check definition by hand, see [Configuration Reference → Discovery Methods](configuration.md#discovery-methods) |
| `--analysis-mode <mode>` | Analysis mode for targeted checks: `custom` (default), `false-positive-validation`, or `general-vuln-discovery` |
| `--severity <level>` | `critical`, `high`, `medium`, `low`, or `informational` |
| `--confidence <level>` | `high`, `medium`, or `low` |

Run `aghast new-check --help` for the full list of flags including `--check-overview`, `--check-items`, `--pass-condition`, `--fail-condition`, `--flag-condition`, `--repositories`, `--semgrep-rules` / `--opengrep-rules` (aliases for the same flag — don't pass both in the same command), `--max-targets`, and `--language`.

## What gets created

Running `new-check` creates a check folder in `<config-dir>/checks/<check-id>/` containing:

- `<id>.json` - check definition (name, severity, type, discovery method, target config)
- `<id>.md` - markdown instructions for AI analysis (not created for `static` checks or targeted checks using a built-in analysis mode)
- `<id>.yaml` - Semgrep/Opengrep rule file (for checks with `semgrep` or `opengrep` discovery — both tools share the same rule syntax)
- `tests/` - Semgrep/Opengrep rule test files (for checks with `semgrep` or `opengrep` discovery)

The check is also registered in `checks-config.json`.

## Check definition schema

See the [Configuration Reference](configuration.md#layer-2-check-definition-idjson) for the full check definition schema, including check types, severity levels, Semgrep target configuration, and path filtering.

## Diff filtering

Every targeted/static check you create automatically participates in [diff filtering](configuration.md#diff-filtering) when the scan is invoked with a diff source (e.g. `--diff-ref`, `AGHAST_DIFF_REF` in a PR workflow). Nothing in the check JSON is required to opt in. If a specific check should stay full-repo even during a diff-scoped scan, set `"diffFilter": false` on its `checkTarget`. See the [Configuration Reference](configuration.md#diff-filtering) for details.

---

<p align="center">
  <a href="scanning.md">&larr; Scanning</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="configuration.md">Configuration Reference &rarr;</a>
</p>
