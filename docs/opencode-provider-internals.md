# OpenCode provider — implementation notes

Developer notes for `src/opencode-provider.ts`. Documents dead ends and confirmed findings from investigation so they aren't re-explored.

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
