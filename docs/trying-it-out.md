<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="getting-started.md">&larr; Getting Started</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="scanning.md">Scanning &rarr;</a>
</p>

---

# Trying It Out

Once you've [installed aghast](getting-started.md), you can either [create your own check](#option-a-create-your-own-check) or [try it out with pre-built examples](#option-b-use-the-example-checks).

## Option A: Create your own check

[Click for a video walkthrough of using the new-check CLI option.](https://youtu.be/5MNadDxwtKk)

Use `aghast new-check` to scaffold a check tailored to your own codebase:

```bash
aghast new-check --config-dir ./my-checks
```

This will:
- Create the config directory and `checks-config.json` if they don't exist
- Prompt you for check details (name, description, pass/fail conditions, check type)
- Create a check folder with the definition file, instructions markdown, and optionally a Semgrep rule

You can also provide all values via flags for non-interactive use:

```bash
aghast new-check --config-dir ./my-checks \
  --id xss --name "XSS Prevention" \
  --check-overview "Verify the application uses proper output encoding" \
  --check-items "HTML encoding,JavaScript encoding,URL encoding" \
  --pass-condition "All outputs are properly encoded" \
  --fail-condition "Unencoded user input found in HTML output"
```

Run `aghast new-check --help` for all available options, or see [Creating Checks](creating-checks.md) for the full reference.

Then run your check:

```bash
aghast scan /path/to/target-repo --config-dir ./my-checks --output-format sarif
```

> **Using OpenCode?** Add `--agent-provider opencode --model opencode/nemotron-3-super-free` to the command above, or choose another model that you want to use.

Results are written to `security_checks_results.sarif` in the target repo, a SARIF 2.1.0 file compatible with GitHub Code Scanning and other SARIF viewers.

## Option B: Use the example checks

The [aghast-bounce-checks-public](https://github.com/BounceSecurity/aghast-bounce-checks-public) repository contains ready-to-run security checks with matching sample codebases. Clone it to get started:

```bash
git clone https://github.com/BounceSecurity/aghast-bounce-checks-public.git
```

The repo includes six example checks demonstrating the three check types (`repository`, `targeted`, `static`) with different discovery methods and analysis modes, with test codebases pre-configured in `checks-config.json`. Each example is described in detail below.

| # | Example | Check type | Discovery | Analysis mode | Requires |
|---|---------|------------|-----------|---------------|----------|
| 1 | [Business Logic Bypass](#example-1-business-logic-bypass-repository-check) | repository | — | — | API key |
| 2 | [Important Validations before AI Queries](#example-2-important-validations-before-ai-queries-targeted-check-semgrep-discovery) | targeted | Semgrep | custom | API key, Semgrep |
| 3 | [Missing API Token Decorator](#example-3-missing-api-token-decorator-static-check-semgrep-discovery) | static | Semgrep | — | Semgrep |
| 4 | [SAST Finding Verification](#example-4-sast-finding-verification-targeted-check-sarif-input-false-positive-validation) | targeted | SARIF input | false-positive validation | API key |
| 5 | [Various Security Vulnerabilities](#example-5-various-security-vulnerabilities-targeted-check-openant-discovery-general-vulnerability-analysis) | targeted | OpenAnt | general vulnerability discovery | API key, OpenAnt |
| 6 | [Diff-Scoped Validation Scanning](#example-6-diff-scoped-validation-scanning-targeted-check-semgrep-discovery-with-diff-filtering) | targeted | Semgrep | custom | API key, Semgrep |

> **Using OpenCode?** All examples that require an API key also work with the OpenCode provider. Add `--agent-provider opencode --model opencode/nemotron-3-super-free` to any `aghast scan` command below, or choose the model you want. See [Scanning → Using OpenCode](scanning.md#using-opencode) for setup.

### Example 1: Business Logic Bypass (repository check)

[Click for a video walkthrough of running this example.](https://youtu.be/k-CqAsOicA4)

#### Check type

`repository` - analyzes the whole codebase with AI. No Semgrep needed.

#### What it does

Looks for endpoints that process financial operations (orders, payments, refunds, coupons) without properly validating client-supplied values. For example, it flags endpoints that accept negative quantities, use client-supplied prices instead of database lookups, allow duplicate coupon applications, or permit refunds exceeding the original order total.

#### Check definition (`aghast-js-business-logic-bypass.json`):

```json
{
  "id": "aghast-js-business-logic-bypass",
  "name": "Business Logic Bypass",
  "instructionsFile": "aghast-js-business-logic-bypass.md",
  "severity": "high",
  "confidence": "medium"
}
```

Since there is no `checkTarget` field, this is a `repository` check. The AI receives the entire codebase and analyzes it according to the instructions in the markdown file. This is the simplest check type to create: you only need a JSON definition and a markdown instructions file.

#### Test codebase

`test-codebases/test-8-business-logic-bypass/` - a Node.js Express app with order and payment routes containing intentional business logic flaws.

#### Run it (requires API key, no Semgrep):

```bash
aghast scan ./aghast-bounce-checks-public/test-codebases/test-8-business-logic-bypass \
  --config-dir ./aghast-bounce-checks-public \
  --output-format sarif
```

#### Expected result

FAIL with 4 issues: negative quantity accepted in add-to-cart, client-supplied price used in express checkout, duplicate coupon application allowed, and refund amount not validated against the order total.

---

### Example 2: Important Validations before AI Queries (targeted check, Semgrep discovery)

[Click for a video walkthrough of running this example.](https://youtu.be/rjYegEg6dx0)

#### Check type

`targeted` with `semgrep` discovery. Semgrep discovers specific code locations, then the AI analyzes each one independently.

#### What it does

Finds Python endpoints that call `send_ai_query()` and checks whether each one performs all four required validations before dispatching the query: role check (JWT manager role), query length check (< 1000 chars), business hours check (9–17 Mon–Fri), and malicious prompt check.

#### Check definition (`aghast-importantvalidations-mc.json`):

```json
{
  "id": "aghast-importantvalidations-mc",
  "name": "Important Validations before performing an AI query (Targeted)",
  "instructionsFile": "aghast-importantvalidations-mc.md",
  "severity": "high",
  "confidence": "medium",
  "checkTarget": {
    "type": "targeted",
    "discovery": "semgrep",
    "rules": "aghast-importantvalidations-mc.yaml",
    "maxTargets": 9999
  }
}
```

The `checkTarget.type` of `targeted` with `"discovery": "semgrep"` makes this a targeted check using Semgrep to find code locations. The Semgrep rule finds all functions containing a `send_ai_query()` call:

```yaml
rules:
  - id: aghast-importantvalidations-mc
    languages:
      - python
    severity: ERROR
    message: |
      API endpoint which communicates with the AI backend detected
    pattern: |
      def $FUNC_NAME():
        ...
        send_ai_query($DATA)
        ...
```

Each Semgrep match becomes a separate target. The AI then analyzes each target individually using the instructions from the markdown file, which describe what validations to look for.

#### Test codebase

`test-codebases/test-2-importantvalidations-easy/` - a Python Flask app with multiple route handlers that call the AI backend, some missing required validations.

#### Run it (requires API key + Semgrep):

```bash
aghast scan ./aghast-bounce-checks-public/test-codebases/test-2-importantvalidations-easy \
  --config-dir ./aghast-bounce-checks-public \
  --output-format sarif
```

#### Expected result

FAIL with 2 issues: Semgrep finds 3 targets (endpoints calling `send_ai_query()`), and the AI reports that the `/run` and `/execute` endpoints are each missing one or more of the four required validations. The `/submit` endpoint passes all four checks.

---

### Example 3: Missing API Token Decorator (static check, Semgrep discovery)

[Click for a video walkthrough of running this example.](https://youtu.be/2P8yAWRJSLk)

#### Check type

`static` with `semgrep` discovery. Semgrep findings are mapped directly to issues with no AI involvement.

#### What it does

Detects Flask route handlers that are missing the `@require_api_token` decorator, which would allow unauthenticated access. Health/status endpoints are excluded via a regex filter.

#### Check definition (`aghast-py-missing-token-decorator.json`):

```json
{
  "id": "aghast-py-missing-token-decorator",
  "name": "Missing API Token Decorator on Flask Endpoints",
  "severity": "high",
  "confidence": "high",
  "checkTarget": {
    "type": "static",
    "discovery": "semgrep",
    "rules": "aghast-py-missing-token-decorator.yaml"
  }
}
```

With `checkTarget.type` set to `static`, there is no instructions file. The Semgrep rule does all the work:

```yaml
rules:
  - id: aghast-py-missing-token-decorator
    patterns:
      - pattern: |
          @$BP.route($PATH, ...)
          def $FUNC(...):
              ...
      - pattern-not: |
          @$BP.route($PATH, ...)
          @require_api_token
          def $FUNC(...):
              ...
      - metavariable-regex:
          metavariable: $PATH
          regex: ^(?!.*(health|ready|readiness|liveness|alive|ping|status))
    message: >
      Flask endpoint '$FUNC' is missing the @require_api_token decorator,
      allowing unauthenticated access to this API endpoint.
    languages: [python]
    severity: ERROR
```

Each Semgrep match is mapped directly to a `SecurityIssue`. No API key needed.

#### Test codebase

`test-codebases/test-7-missing-token-decorator/` - a Python Flask app with several route handlers, some missing the required decorator.

#### Run it (requires Semgrep, no API key):

```bash
aghast scan ./aghast-bounce-checks-public/test-codebases/test-7-missing-token-decorator \
  --config-dir ./aghast-bounce-checks-public \
  --output-format sarif
```

#### Expected result

FAIL with 4 issues: four endpoints across three route files are missing the `@require_api_token` decorator. Health and readiness endpoints are correctly excluded by the Semgrep rule's regex filter.

---

### Example 4: SAST Finding Verification (targeted check, SARIF input, false-positive validation)

[Click for a video walkthrough of running this example.](https://youtu.be/I3b2Cn87ugg)

#### Check type

`targeted` with `sarif` discovery. Reads findings from a SARIF file specified in the check definition and has the AI validate each one as a true or false positive.

#### What it does

Takes SARIF output from a generic SAST tool and verifies whether each reported finding is actually exploitable. The AI reads the code at each flagged location and considers context like framework protections, input validation, and data flow to determine if the finding is real.

#### Check definition (`aghast-sast-verify.json`):

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
    "sarifFile": "./sast-results.sarif",
    "analysisMode": "false-positive-validation"
  }
}
```

The `analysisMode` of `false-positive-validation` uses a built-in prompt that evaluates each finding as a true or false positive — no custom analysis instructions needed. The optional `instructionsFile` provides supplementary context about the target codebase (in this case, that the app uses Flask with Jinja2 templates and a link to Flask's security docs). The `sarifFile` field points to the SARIF file containing findings to analyze, resolved relative to the target repo.

#### Test codebase

`test-codebases/test-9-sast-false-positives/` - a Python Flask app with a mix of true and false positives for XSS, open redirect, and SSRF.

#### Sample SARIF file

`test-codebases/test-9-sast-false-positives/sast-results.sarif` - contains 7 findings (3 true positives, 4 false positives).

#### Run it (requires API key, no Semgrep needed):

```bash
aghast scan ./aghast-bounce-checks-public/test-codebases/test-9-sast-false-positives \
  --config-dir ./aghast-bounce-checks-public \
  --output-format sarif
```

#### Expected result

FAIL with ~3 issues: the AI should confirm the true positive findings (unescaped user input in HTML response, unvalidated redirect, user-supplied URL fetched without validation) and dismiss the false positives (autoescaped template output, allowlist-validated redirects, hardcoded internal URLs).

---

### Example 5: Various Security Vulnerabilities (targeted check, OpenAnt discovery, general vulnerability analysis)

[Click for a video walkthrough of running this example.](https://youtu.be/pALxeunbH7s)

#### Check type

`targeted` with `openant` discovery. Runs `openant parse` on the target repo to extract code units, then has the AI independently analyze each unit for security vulnerabilities.

#### What it does

Analyzes individual functions extracted by [OpenAnt](https://github.com/knostic/OpenAnt) for a range of security issues including race conditions, broken access control, SSRF, SQL injection, mass assignment, and insecure randomness. The AI browses the live codebase to trace data flow and verify each finding.

#### Check definition (`aghast-openant-various-vulns.json`):

```json
{
  "id": "aghast-openant-various-vulns",
  "name": "Various Security Vulnerabilities (OpenAnt Example)",
  "severity": "high",
  "confidence": "medium",
  "model": "sonnet",
  "checkTarget": {
    "type": "targeted",
    "discovery": "openant",
    "analysisMode": "general-vuln-discovery",
    "concurrency": 10
  }
}
```

With `checkTarget.type` set to `targeted` and `"discovery": "openant"`, aghast runs `openant parse` on the target repo to extract code units. The `analysisMode` of `general-vuln-discovery` uses a built-in prompt that scans each unit for a broad range of security vulnerabilities, so no custom instructions file is needed. The `model` field overrides the default model for this check (sonnet provides more consistent results for complex security analysis). The `concurrency` field controls how many units are analyzed in parallel.

OpenAnt extracts code units with call graph metadata (callers, callees, entry point status) but **not** OpenAnt's security classifications. The AI forms its own independent judgment from the code.

#### Test codebase

`test-codebases/test-10-various-vulns/` - a Node.js Express inventory management API with a mix of vulnerable and safe code patterns. Vulnerable functions have safe counterparts nearby (e.g., a single order endpoint with a race condition alongside a bulk order endpoint with proper transaction locking).

#### Run it (requires API key + OpenAnt + Python 3.11+, no Semgrep needed):

```bash
aghast scan ./aghast-bounce-checks-public/test-codebases/test-10-various-vulns \
  --config-dir ./aghast-bounce-checks-public \
  --output-format sarif
```

#### Expected result

FAIL with ~8 issues: race condition in order creation, mass assignment allowing role escalation, insecure randomness in password reset tokens, SQL injection in custom report export, SSRF in custom export endpoint, SSRF via unvalidated webhook registration and test delivery, and broken object-level authorization in order retrieval.

> **Note**: Because the AI independently analyzes each code unit, results may vary slightly between runs. The sonnet model provides the most consistent results.

---

### Example 6: Diff-Scoped Validation Scanning (targeted check, Semgrep discovery with diff filtering)

#### Check type

`targeted` with `semgrep` discovery. Functionally the same as Example 2 — Semgrep finds the code locations, the AI analyzes each one — but this example demonstrates **diff filtering**: when a diff source is supplied at scan time, findings are automatically narrowed to the code the change actually touches. No special check field is required; diff filtering is a cross-cutting behavior that activates whenever a diff source is present.

#### What it does

Finds Python endpoints that call `send_ai_query()` and checks whether each one performs all four required validations before dispatching the query: role check (JWT manager role), query length check (< 1000 chars), business hours check (9–17 Mon–Fri), and malicious prompt check. Without a diff source it analyzes every matching endpoint; with one, it analyzes only the endpoints in diff scope.

#### Check definition (`aghast-importantvalidations-diff.json`):

```json
{
  "id": "aghast-importantvalidations-diff",
  "name": "Important Validations before performing an AI query (Diff-filtered)",
  "instructionsFile": "aghast-importantvalidations-diff.md",
  "severity": "high",
  "confidence": "medium",
  "checkTarget": {
    "type": "targeted",
    "discovery": "semgrep",
    "rules": "aghast-importantvalidations-diff.yaml",
    "maxTargets": 9999
  }
}
```

Note there is no diff-related field in the definition. Diff filtering is driven entirely by whether a diff source is provided to the scan (`--diff-file`, `--diff-ref`, or `AGHAST_DIFF_REF`). A check can opt out with `checkTarget.diffFilter: false`. See the [Configuration Reference](configuration.md#diff-filtering) for the full behavior.

#### Test codebase

`test-codebases/test-13-importantvalidations-diff/` - a Python Flask app with nine endpoints that call the AI backend across three route modules, each with differing validation coverage. The folder also ships `example.diff`, a sample unified diff that modifies two of the endpoints (`/api/v1/execute`, `/api/v1/dispatch`) and a shared `check_rate_limit` helper.

#### Run it without a diff source (requires API key + Semgrep):

```bash
aghast scan ./aghast-bounce-checks-public/test-codebases/test-13-importantvalidations-diff \
  --config-dir ./aghast-bounce-checks-public \
  --output-format sarif
```

All nine endpoints are analyzed — this is the full-repo baseline.

#### Run it with a diff source (diff-scoped):

```bash
aghast scan ./aghast-bounce-checks-public/test-codebases/test-13-importantvalidations-diff \
  --config-dir ./aghast-bounce-checks-public \
  --diff-file ./aghast-bounce-checks-public/test-codebases/test-13-importantvalidations-diff/example.diff \
  --output-format sarif
```

#### Expected result

Without a diff source: nine endpoints analyzed.

With `--diff-file` and OpenAnt available: the nine candidates are narrowed to **three** — `example.diff` touches `/api/v1/execute` and `/api/v1/dispatch` directly, and OpenAnt's call graph adds `/api/v1/invoke` because it calls the modified `check_rate_limit` helper. FAIL with ~2 issues: `/api/v1/execute` performs none of the four validations and `/api/v1/invoke` is missing the query-length and business-hours checks; `/api/v1/dispatch` performs all four and passes.

If OpenAnt is not installed, the diff filter falls back to file/line overlap only (depth-0, no call-graph flow, logged with a warning): **two** endpoints analyzed (`/api/v1/execute`, `/api/v1/dispatch`), FAIL with ~1 issue. Installing OpenAnt (or setting `AGHAST_OPENANT_DATASET`) enables the richer depth-1 filtering. See [How It Works](how-it-works.md) for the depth-0 vs depth-1 distinction.

> **Note**: Because the AI analyzes each endpoint independently, the exact issue wording may vary slightly between runs.

---

### Running example checks against your own code

The checks in `checks-config.json` include a `repositories` field that limits which repos each check runs against. To run the example checks against your own repository, add your repo's path or remote URL to the `repositories` array for the relevant check, or set it to an empty array `[]` to match all repositories. See the [Configuration Reference](configuration.md) for details.

## What's next

- [Scanning](scanning.md) - all scan options, output formats, and environment variables
- [Creating Checks](creating-checks.md) - detailed reference for the `new-check` command
- [Configuration Reference](configuration.md) - config directory structure, check schemas, and runtime config

---

<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="getting-started.md">&larr; Getting Started</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="scanning.md">Scanning &rarr;</a>
</p>
