<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="how-it-works.md">&larr; How It Works</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="trying-it-out.md">Trying It Out &rarr;</a>
</p>

---

# Getting Started with aghast

This guide walks you through installing aghast and setting up your environment.

## Prerequisites

- **Node.js 20+**
- **An agent provider**, required for AI-based checks (`repository` and `targeted` types; not needed for `static` checks). Either:
  - An **Anthropic API key** for the default `claude-code` provider, or
  - **[OpenCode](https://opencode.ai)** installed and authenticated for the `opencode` provider, which delegates to any of the 75+ LLM providers OpenCode supports, including some **free options**.

  See [Scanning → Agent Providers](scanning.md#agent-providers) for the full comparison.
- For checks that use `semgrep` discovery: **[Semgrep Community Edition](https://semgrep.dev/docs/getting-started/)** (LGPL-2.1)
- For checks that use `openant` discovery: **[OpenAnt](https://github.com/knostic/OpenAnt)** (Apache-2.0) + **Python 3.11+** + **Go** (for building CLI)

## 1. Install aghast

```bash
npm install -g @bouncesecurity/aghast@0.7.2
```

To uninstall:

```bash
npm uninstall -g @bouncesecurity/aghast
```

## 2. Set up an agent provider

Required for `repository` and `targeted` checks. Skip this step entirely if you only plan to run `static` checks.

**Option A — Claude Code (default)**

```bash
export ANTHROPIC_API_KEY=your-api-key
```

Claude Code is the default provider, so no flag is needed at scan time. To override the model, pass `--model <name>` per scan (see [Scanning](scanning.md)) or pin a default as shown below.

**Option B — OpenCode**

Install OpenCode from [https://opencode.ai](https://opencode.ai), then run `opencode` and use `/connect` to configure credentials for at least one LLM provider. Then pick either per-scan flags or a persistent default:

```bash
# Per-scan:
aghast scan <repo-path> --config-dir <path> --agent-provider opencode --model opencode/nemotron-3-super-free
```

**Pin defaults (applies to both options).** Use `aghast build-config` to write a `runtime-config.json` in your config directory so future scans use your chosen provider and model without any flags:

```bash
aghast build-config --config-dir <path>            # interactive (covers both options)

# Option A — pin claude-code with a specific model:
aghast build-config --config-dir <path> --provider claude-code --model sonnet --non-interactive

# Option B — pin opencode with a specific model:
aghast build-config --config-dir <path> --provider opencode --model opencode/nemotron-3-super-free --non-interactive
```

See [Configuration Reference → Runtime Configuration](configuration.md#runtime-configuration) for the full schema.

## What's next

Head to [Trying It Out](trying-it-out.md) to run your first scan, either using pre-built example checks or by creating your own.

---

<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="how-it-works.md">&larr; How It Works</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="trying-it-out.md">Trying It Out &rarr;</a>
</p>
