# OpenCode provider — implementation notes

Developer notes for `src/opencode-provider.ts`. Documents dead ends and confirmed findings from investigation so they aren't re-explored.

## OpenCode 2 adapter (2.0.23)

`src/opencode-client.ts` maps the published Promise client into the provider's
internal contract. The dependency named `@opencode-ai/client` is an npm alias of
`@opencode/client@2.0.23`: the old scope's default release is a placeholder, while
the stable client and CLI use `@opencode/*`. CI installs `@opencode/cli@2.0.23`.
The client event implementation uses `Promise.withResolvers`, so this provider
requires Node.js 22+; Aghast's other providers retain Node.js 20 support.

Sources: [JavaScript client guide](https://opencode.ai/v2/docs/build/client/),
[HTTP API reference](https://opencode.ai/v2/docs/api), and
[permissions](https://opencode.ai/v2/docs/permissions/). The pinned package's
generated declarations determine the exact request shapes.

| Provider operation | OpenCode 2 mapping |
| --- | --- |
| Model validation/listing | Wait for the last guarded built-in plugin (`opencode.config.policy`) to enter the inventory, then join `provider.list().data` and enabled `model.list().data` by provider ID; use the selectable model `id`, not upstream `modelID` |
| Session creation | `session.create({ title, location: { directory }, permissions })` |
| Read-only permissions | Wildcard deny followed by read/glob/grep/list allows; shell is approval-gated and every request is automatically rejected through the permission API |
| Prompt | `session.switchModel()`, then `session.prompt({ sessionID, text })`, `session.wait()`, and `message.list()` for the latest assistant message |
| Structured output | Append the JSON schema to the prompt and parse text with Aghast's existing parser; v2 has no legacy prompt `format` field |
| Token usage/cost | Session totals include all steps in the tool loop |
| Events | Map `session.tool.*` to existing tool-progress logging and terminal execution failures/interruption to session errors; ignore retryable step failures |

The owned `opencode serve` process announces a URL and password on stdout.
Capture both (or use `OPENCODE_PASSWORD` / legacy `OPENCODE_SERVER_PASSWORD`
when set, since the password banner is then omitted), send Basic authentication
as `opencode`, and never forward the password to logs. Cleanup stops the owned process tree, including the Windows
command wrapper. Request cancellation propagates through model selection,
prompt submission, completion wait, and result retrieval.

`tests/opencode-v2.test.ts` exercises the real published client using a local
fetch transport, without credentials or LLM calls. Existing provider tests keep
their injected client and remain unchanged. Live tests still require providers
configured in OpenCode 2. CI explicitly enables anonymous `opencode/big-pickle`
using `.github/opencode-install/ci-config.json` through `OPENCODE_CONFIG`. It uses
the native OpenAI-compatible runtime, `https://opencode.ai/zen/v1`, and the `public`
key; no paid provider credentials or local inference runtime are needed.

On 2026-10-06, isolated experiments reproduced Zen's misleading "free tier can
only be used from within OpenCode" rejection: default API permissions succeeded,
while even denying only `shell` failed. Making shell approval-gated succeeded.
The adapter therefore keeps other non-read-only tools denied and polls the owned
session's pending permissions independently of the optional progress SSE stream,
always replying `reject` to shell requests. Rejection includes feedback so the
model can continue with read-only tools. Transport failures abort the prompt and
interrupt the session; polling is cancelled on completion or caller cancellation.
All five unchanged live integration tests passed in an empty project with isolated
OpenCode config/data/cache and the anonymous CI configuration. A separate live
probe confirmed that Aghast actually sent `decision: "reject"` for a shell request
and the model continued successfully.

OpenCode applies saved project approvals after session `ask` rules. Before sending
a prompt, the adapter refuses projects with saved shell approvals (including
wildcard actions), leaving those user approvals untouched. The permission API is
accessed with the session's project ID and directory, not the server's default
directory. Use an isolated project or remove conflicting saved approvals in
OpenCode. The owned server is private: do not concurrently modify its session or
project permission state from another client while a scan is running.

The HTTP listening banner does not imply plugin readiness;
catalog reads wait up to 30 seconds for activation rather than misreporting an
initially empty catalog as an unconfigured provider.

## Historical OpenCode 1 observations

The notes below describe the legacy SDK and server and are retained for context.
Their endpoints, events, and flags do not define the OpenCode 2 integration.

---

## SSE event types (opencode v1.15.5)

**Use `message.part.updated`, not `session.next.tool.*`.**

The SDK type file (`dist/v2/gen/types.gen.d.ts`) declares both event families in the `Event` union:
- `message.part.updated` — carries a typed `Part` object with `state.status` (pending / running / completed / error), `state.input`, `state.output`
- `session.next.tool.called`, `session.next.tool.success`, `session.next.tool.failed`, `session.next.text.delta`, etc.

In practice, the running server (v1.15.5) only publishes `message.part.updated` and `message.part.delta`. The `session.next.*` family was never observed across multiple spike runs including tool-forcing prompts. Do not chase `session.next.*` events until confirmed working in a newer server version.

**Session scoping field:** `properties.sessionID` (confirmed from spike). The `/event` SSE stream carries events for all sessions on the server; filter by this field to isolate a single check's events.

**`session.error` shape:**
```json
{
  "type": "session.error",
  "properties": {
    "sessionID": "ses_...",
    "error": {
      "name": "UnknownError",
      "data": { "message": "Model not found: provider/model." }
    }
  }
}
```
Access the human-readable message via `properties.error.data.message`.

---

## Server-side debug logs (`--print-logs`)

**`--log-level=DEBUG` does not produce more output.** Source analysis of the opencode server confirmed that the hot paths — `session/llm.ts`, `session/prompt.ts`, `session/processor.ts`, `provider/provider.ts`, `tool/shell.ts`, `permission/index.ts` — contain no `.debug()` call sites. Only INFO is emitted on the prompt path regardless of the `--log-level` flag. There are ~35 `.debug()` sites in the codebase but they are all in config loading, MCP transport, LSP, and TUI code that never runs during `serve`.

**`--print-logs` and disk logging are mutually exclusive.** When `--print-logs` is set, `log.ts` skips `createWriteStream` entirely — no log file is created in `~/.local/share/opencode/log/`. The flag redirects the same log lines to stderr instead of disk.

**Most INFO lines are noise**, but `service=llm` lines are valuable: they include each LLM request attempt and — crucially — 429 rate-limit retries that opencode handles internally without emitting `session.error`. Without these lines, a rate-limited scan looks identical to a thinking scan from aghast's perspective. The implementation therefore captures stderr but filters to only `service=llm`, `service=permission`, `service=provider`, and `service=session.prompt` lines (see `USEFUL_SERVER_LOG` regex in `opencode-provider.ts`), discarding `service=bus`, `service=tool.registry`, `service=snapshot`, and all other noise.

**`service=llm` error lines contain the full request body.** When the model hits a 429 (or any other API error), the logged line includes the complete LLM request body — system prompt, user messages, tool schemas — making the raw line many kilobytes long and unreadable on the console. `summariseServerError()` in `opencode-provider.ts` extracts the useful fields via regex (`providerID`, `modelID`, `statusCode`, `isRetryable`) and emits a compact one-liner at info level, e.g.:
```
[opencode-server] HTTP 429 — nvidia/moonshotai/kimi-k2.6 (retrying)
```
The full raw line is still forwarded at trace level for deep diagnosis.

**Log level split:** `service=llm` error lines (matching `\berror\b`) → `logProgress` (info, always visible). Normal streaming heartbeat lines → `logTrace` (trace only, file log).

**`getLogLevel()` only reads the console handler.** When running with `--log-file`, the file handler is typically at `trace` while the console stays at `info`. `getLogLevel()` returns `'info'` in that case, so any code gating on `isDebugOrTrace = getLogLevel() === 'debug' || ...` will silently disable itself even though the file log is capturing debug/trace output. Use `isDebugEnabled()` / `isTraceEnabled()` from `logging.ts` instead — these check the minimum level across all registered handlers.

---

## `session.create` model field

The `model` body parameter is an **object**, not a string:
```ts
{ id: string; providerID: string; variant?: string }
```
Passing a `"providerID/modelID"` string is silently ignored by the server (session creates successfully but uses the default model).

---

## `@opencode-ai/sdk/dist/process.js` is not exported

The package exports map does not include `./dist/process.js`. Attempting to import `stop` or `bindAbort` from that path throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. If you need process lifecycle helpers, inline the ~10-line `stop()` function directly.

---

## ⚠️ Open issue: agentic loop not running for some models

**Observed with `nvidia/moonshotai/kimi-k2.6`.** `session.prompt()` is supposed to run the full agentic loop — execute tool calls, feed results back, and loop until the model produces a final answer. In practice, with this model the loop does not run: the SSE stream reports 0 tool call parts, and the "response" text returned by `extractTextFromParts()` is a JSON array of tool call invocations the model wanted to make, e.g.:

```json
[{"name": "read", "parameters": {"filePath": "routes\\run.py"}}]
```

This surfaces as a `StructuredOutputError` (the structured output schema check fails because the text is not `{"issues":[...]}`), falls through to text parsing, and produces a malformed response error.

**The model is doing the right thing** — trying to read files before answering — but the tool execution step never happens. The full request body (visible in `service=llm` error lines at trace level) confirms opencode sends `tool_choice: required` with read/glob/grep/StructuredOutput tools. The model responds with tool call API invocations but they don't execute.

**Root cause not yet confirmed.** Candidates:
- Model-specific incompatibility with opencode's function-calling mechanism (kimi-k2.6 via NVIDIA's API endpoint)
- Conflict between `format: { type: 'json_schema', schema: OUTPUT_SCHEMA }` on `session.prompt()` and the tool execution loop
- opencode version (v1.15.5) not fully supporting this model's tool-call response format

**Do not assume this is fixed by changing aghast's code alone.** The spike (scripts/opencode-logging-spike.ts, now deleted) confirmed that `session.prompt()` works correctly end-to-end with models that support the mechanism. The failure is model/provider-specific.
