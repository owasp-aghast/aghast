# AI Guided Hybrid Application Static Testing (AGHAST)

![Status: Beta](https://img.shields.io/badge/Status-Beta-yellow)
[![CI](https://github.com/owasp-aghast/aghast/actions/workflows/ci.yml/badge.svg)](https://github.com/owasp-aghast/aghast/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/owasp-aghast/aghast/badge)](https://scorecard.dev/viewer/?uri=github.com/owasp-aghast/aghast)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12560/badge)](https://www.bestpractices.dev/projects/12560)
[![OWASP Incubator](https://img.shields.io/badge/OWASP-Incubator_Project-blue.svg)](https://aghast.owasp.org)
[![Maintaining Supporter: Bounce Security](https://img.shields.io/badge/Maintaining_Supporter-Bounce_Security-f79421)](https://bouncesecurity.com/)

> **Note**
> AGHAST is in **beta** and may have unexpected bugs. We follow [semantic versioning](https://semver.org/) — breaking changes to APIs, CLI flags, configuration formats, and output schemas will only occur in minor version bumps (0.x.0) until we reach 1.0.

You know what your key code security concerns are. But how do you check for them in a way that is automatable, repeatable and scalable? If generic SAST is doing this for you, feel free to stop reading now 😀.

For the rest of us, AGHAST is an open-source framework that lets you define and check for these concerns. It blends the advantages of static discovery and AI-powered analysis to efficiently find code-specific and company-specific security issues.

Define your checks, which repositories they relate to, and get accurate and structured results (JSON or SARIF).

<p align="center">
  <img src="/assets/img/aghastowaspcaption.png" alt="AGHAST" width="50%">
</p>

## What AGHAST Does

* AGHAST is an [OWASP](https://owasp.org/) Incubator project — see the [project page at aghast.owasp.org](https://aghast.owasp.org) for full details. It is maintained with the support of [Bounce Security](https://bouncesecurity.com/).
* There is a brief introduction video [here](https://www.youtube.com/watch?v=B76A33l1LyI).
* For a conceptual walkthrough of how each check type works, see [How It Works](docs/how-it-works.md).
* Alternatively, there are examples of several check types in [Trying It Out](docs/trying-it-out.md#option-b-use-the-example-checks) with video explanations of [in this YouTube playlist](https://www.youtube.com/playlist?list=PLjjq7fuK4pqubFNVw3miBpdd6TXif4WHW).


To cut to the chase, AGHAST uses three core mechanisms:

- **Repository-wide AI analysis** — let the LLM analyze the whole repo against your security check instructions
- **Targeted checks** — a pluggable discovery method (Semgrep or Opengrep rules, [OpenAnt](https://github.com/knostic/OpenAnt/) code units, or external SARIF findings) identifies specific code locations, then AI analyzes each independently. This is the sweet spot for most use cases
- **Static checks** — a discovery method (Semgrep or Opengrep) finds issues mapped directly to results with no AI involvement, for when a traditional static rule is all you need

The beauty of the approach is what you *don't* need:

- You don't need to modify the code
- You don't need to build something into the codebase
- You don't need to write code in the language of the codebase

All you need is:

- Access to the codebase
- An understanding of the problem you are trying to discover
- The ability to write some simple rules

There are almost certainly other ways of achieving this, but to our mind, this approach is both straightforward and deterministic.

## Prerequisites

- **Node.js 20+**
- **An agent provider**, required for AI-based checks (`repository` and `targeted` types; not needed for `static` checks). Either:
  - An **Anthropic API key** for the default `claude-code` provider, or
  - **[OpenCode](https://opencode.ai)** installed and authenticated for the `opencode` provider, which delegates to any of the 75+ LLM providers OpenCode supports, including some **free options**.

  See [Scanning → Agent Providers](docs/scanning.md#agent-providers) for the full comparison.
- For checks that use `semgrep` discovery: **[Semgrep Community Edition](https://semgrep.dev/docs/getting-started/)** (LGPL-2.1)
- For checks that use `opengrep` discovery: **[Opengrep](https://github.com/opengrep/opengrep)** (LGPL-2.1 fork of Semgrep)
- For checks that use `openant` discovery: **[OpenAnt](https://github.com/knostic/OpenAnt/)** (Apache-2.0) + **Python 3.11+** + **Go** (for building CLI)

## Quick Start

See the [Getting Started guide](docs/getting-started.md) to install aghast and [Trying It Out](docs/trying-it-out.md) to run your first scan.

## Example Output

Results are structured JSON (or SARIF) with per-check status and detailed issues:

```json
{
  "checks": [
    { "checkId": "aghast-api-authz", "checkName": "API Authorization Check", "status": "FAIL", "issuesFound": 1 },
    { "checkId": "aghast-sql-injection", "checkName": "SQL Injection Prevention", "status": "PASS", "issuesFound": 0 }
  ],
  "issues": [
    {
      "checkId": "aghast-api-authz",
      "checkName": "API Authorization Check",
      "file": "src/api/users.ts",
      "startLine": 45,
      "endLine": 52,
      "description": "Missing authorization check on DELETE endpoint.",
      "codeSnippet": "router.delete('/users/:id', async (req, res) => {"
    }
  ],
  "summary": {
    "totalChecks": 2,
    "passedChecks": 1,
    "failedChecks": 1,
    "flaggedChecks": 0,
    "errorChecks": 0,
    "totalIssues": 1
  }
}
```

## Documentation

- [How It Works](docs/how-it-works.md) — conceptual overview of the three check types
- [Getting Started](docs/getting-started.md) — installation, setup, and first scan
- [Trying It Out](docs/trying-it-out.md) — example checks walkthrough and first scan guide
- [Scanning](docs/scanning.md) — scan command options, environment variables, output formats
- [Cost Tracking](docs/cost-tracking.md) — how scan cost is measured, sources, and labels
- [Creating Checks](docs/creating-checks.md) — scaffolding new security checks
- [Configuration Reference](docs/configuration.md) — check schemas, check types, runtime config
- [Development](docs/development.md) — setup, building, testing, releasing

## Maintainers and Supporters

This is an [OWASP](https://owasp.org/) Incubator project, led by:

- Josh Grossman ([josh.grossman@owasp.org](mailto:josh.grossman@owasp.org))
- Avi Douglen ([avi.douglen@owasp.org](mailto:avi.douglen@owasp.org))

[Bounce Security](https://bouncesecurity.com/) is the original contributor and continues as a **maintaining supporter** of the project.

## Contributing

Use [GitHub Issues](https://github.com/owasp-aghast/aghast/issues) for questions, bug reports, and feature requests. We are not currently accepting pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the current contribution policy.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).

Copyright (C) 2026 [OWASP Foundation](https://owasp.org/). Originally contributed by [Bounce Consulting Ltd.](https://bouncesecurity.com/)
