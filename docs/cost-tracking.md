<p align="center">
  <strong>AGHAST Documentation</strong><br>
  <a href="scanning.md">&larr; Scanning</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="README.md">&uarr; Documentation Index</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;<a href="creating-checks.md">Creating Checks &rarr;</a>
</p>

---

# Cost Tracking

AGHAST estimates the USD cost of the AI calls made during a scan and shows
the result in the end-of-scan banner and `aghast stats`. This page explains
where the numbers come from, how to interpret the source labels, and how to
verify accuracy.

**Note:** Cost estimates are *informational*, not authoritative for billing.
For billing, always use your provider's console.

---

## What "cost" means in aghast

Every AI call (one per check, or one per target for targeted checks) consumes
tokens. AGHAST adds up those tokens and maps them to a USD amount. The total
appears in the scan banner:

```
  Tokens:        47,200 (in: 38,000, out: 9,200, cache-read: 32,000)
  Cost:          $0.0123  (reported by claude-agent-sdk)
```

---

## Three cost sources, in trustworthiness order

### 1. Claude Agent SDK `total_cost_usd` — `(reported by claude-agent-sdk)`

Used when running with the `claude-code` agent provider.

The Claude Agent SDK returns a `total_cost_usd` field on every result message.
This number is computed by Claude Code itself, accounts for prompt-cache
discounts (cache reads are billed at roughly 10% of the regular input rate,
cache writes at roughly 125%), and reflects any provider-side adjustments.
It is as accurate as any cost figure available outside the Anthropic Console.

When the `claude-code` provider runs against a local Claude session instead of
an API key, the SDK reports an API-equivalent figure. AGHAST labels it
`(covered by subscription — claude-agent-sdk)` and shows the word "equivalent"
in the banner. See [Subscription mode](#subscription-mode-local-claude) below.

### 2. OpenCode `msg.cost` — `(reported by opencode — see docs/cost-tracking.md)`

Used when running with the `opencode` agent provider.

OpenCode computes a cost locally by fetching pricing from `models.dev` at
runtime and multiplying by token counts. This is strictly better than our
static table for the wide range of providers OpenCode supports (Bedrock,
OpenAI, Vertex, Ollama, etc.) where we have no local pricing entries.

However, OpenCode's cost reporting has documented accuracy issues:

- Reports `$0` for some custom-model providers
  ([sst/opencode#17223](https://github.com/sst/opencode/issues/17223),
  [#4162](https://github.com/sst/opencode/issues/4162))
- Costs may drop unexpectedly on session finalisation
  ([#485](https://github.com/sst/opencode/issues/485))
- OpenRouter costs reported incorrectly
  ([#454](https://github.com/sst/opencode/issues/454))
- Multi-agent / sub-session aggregation gaps
  ([RFC #12377](https://github.com/sst/opencode/issues/12377))

Treat the OpenCode figure as an estimate; reconcile against your provider
console for billing decisions.

### 3. `config/pricing.json` rate fallback — `(estimated from config/pricing.json)`

Used only when neither of the above sources reports a cost. This happens when
using a custom agent provider, or when the SDK does not return a cost field.

AGHAST ships with hand-maintained per-million-token rates for Haiku, Sonnet,
and Opus in `config/pricing.json`. These are estimates: provider pricing
changes over time. You can override them via the `pricing` section of
`runtime-config.json`:

```json
{
  "pricing": {
    "models": {
      "claude-sonnet-4-6": {
        "inputPerMillion": 3.0,
        "outputPerMillion": 15.0,
        "cacheReadPerMillion": 0.3,
        "cacheWritePerMillion": 3.75
      }
    }
  }
}
```

---

## Cache tokens

Prompt caching can reduce AI costs by 5–10× on repeated scans of the same
repository (most input tokens on the second and later runs come from the
cache rather than fresh input).

When cache token counts are available, AGHAST shows them in the token line:

```
  Tokens:        47,200 (in: 38,000, out: 9,200, cache-read: 32,000, cache-write: 5,000)
```

For the rate-table fallback, cache reads and writes are costed at the
`cacheReadPerMillion` and `cacheWritePerMillion` rates in `pricing.json`.

---

## Subscription mode (local Claude)

When the `claude-code` provider authenticates with a local Claude session
instead of an API key — auto-detected when no `ANTHROPIC_API_KEY` is set but
you're logged in to a local session — AGHAST uses that session rather than the
API. **No per-token billing occurs** — consumption comes out of your Pro or Max
subscription quota instead.

The Claude Agent SDK still returns a `total_cost_usd` value in this mode. That
number represents the API-equivalent cost of the work — what it *would have*
cost at standard pay-as-you-go rates. AGHAST shows it as:

```
  Cost:          $0.1065 equivalent  (covered by subscription — claude-agent-sdk)
```

The word **equivalent** signals that you did not actually pay that amount.

**Budget limits in local-Claude mode** are enforced against the equivalent
figure, not against any real spend. If you set `--budget-limit-cost`, AGHAST
will warn and abort based on the API-equivalent total. This can be useful as a
rough quota proxy; AGHAST logs a warning at scan start to remind you:

```
Budget limits in local-Claude mode apply to equivalent API cost, not subscription usage.
```

---

## Source labels

| Banner / stats label | Meaning |
|---|---|
| `(reported by claude-agent-sdk)` | Authoritative total from the Claude Agent SDK |
| `(covered by subscription — claude-agent-sdk)` | API-equivalent figure; no charge (subscription mode) |
| `(reported by opencode — see docs/cost-tracking.md)` | OpenCode-computed total; see caveats above |
| `(estimated from config/pricing.json)` | Rate-table fallback using local pricing file |
| `(estimated — model not in pricing table)` | Model not found in pricing; cost reported as $0 |
| `(legacy estimate)` | Record written before source tracking was added |

---

## Legacy records

Scan history records written before this cost-accuracy fix landed do not have
a `costSource` field. `aghast stats` displays them with a `(legacy estimate)`
label. The numbers in those records were computed using the static rate table
without cache discounts, so they may over-estimate cost significantly for
scans where prompt caching was active.

To drop legacy records:

```bash
# Override history file location to start fresh
export AGHAST_HISTORY_FILE=~/.aghast/history-new.json

# Or delete the history file entirely (it will be recreated on next scan)
rm ~/.aghast/history.json
```

---

## How to verify

To confirm accuracy for the `claude-code` provider:

1. Run a scan with `ANTHROPIC_API_KEY` set:
   ```bash
   aghast scan /path/to/repo --config-dir /path/to/checks
   ```
2. Note the cost shown in the banner and in `aghast stats --json`.
3. Open the [Anthropic Console](https://console.anthropic.com/) and look at
   your usage for the same time window.
4. Compare totals. **Acceptance threshold: < 1% divergence.**

For the `opencode` provider, divergence is expected due to the upstream issues
noted above. Record the divergence in a comment for reference; it is not a
merge blocker.

---

## What is *not* counted

- Semgrep and OpenAnt compute time (CPU / CI minutes)
- Web search or tool-call costs if the SDK does not surface them in token usage
- API calls made by AGHAST itself (repository analysis, pricing file loads)
- Anything bypassing the agent SDK
