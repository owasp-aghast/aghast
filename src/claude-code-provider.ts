/**
 * Claude Code agent provider implementation.
 * Uses @anthropic-ai/claude-agent-sdk per spec Section 6.2 / Appendix C.8.
 */

import type { AgentProvider, AgentResponse, ProviderConfig, CheckResponse, ProviderModelInfo, TokenUsage } from './types.js';
import { DEFAULT_MODEL, FatalProviderError } from './types.js';
// import { parseAgentResponse } from './response-parser.js';
import { logProgress, logDebug, logDebugFull, createTimer, getLogLevel } from './logging.js';
import { OUTPUT_SCHEMA } from './provider-utils.js';

const TAG = 'agent-provider';

/** Hit the Anthropic API /v1/models endpoint (full canonical model list). */
async function listModelsViaApiKey(apiKey: string): Promise<readonly ProviderModelInfo[]> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const out: ProviderModelInfo[] = [];
  // `limit` is the page size, NOT a total cap — `for await` keeps fetching pages
  // via the SDK's auto-pagination until the server reports no more.
  for await (const m of client.models.list({ limit: 100 })) {
    out.push({ id: m.id, label: m.display_name });
  }
  return out;
}

/** Ask the Claude Code agent SDK for its curated alias list (works with local-Claude auth).
 *
 * The SDK's `supportedModels()` is only available on a `Query` instance, not as a static
 * call, so we have to spin up a streaming-input query just to issue one control request.
 * The async generator never yields — we just await `block` so the SDK doesn't think the
 * input stream has ended, then `interrupt()` it after `supportedModels()` returns.
 *
 * Best-effort cleanup: `release()` ends the prompt generator, then `interrupt()` cancels
 * the query. Both are wrapped in a 5s timeout so a misbehaving SDK can't hang the CLI.
 */
async function listModelsViaAgentSdk(): Promise<readonly ProviderModelInfo[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release: (() => void) | undefined;
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  // eslint-disable-next-line require-yield -- intentional: streaming-input prompt that never yields, kept alive by `block` so `supportedModels()` can run.
  const prompt = (async function* (): AsyncGenerator<never, void, unknown> {
    await block;
    await new Promise<never>(() => {});
  })();
  const q = query({ prompt, options: {} });
  try {
    const models = await q.supportedModels();
    return models.map((m) => ({
      id: m.value,
      label: m.displayName,
      description: m.description,
    }));
  } finally {
    release?.();
    await Promise.race([
      q.interrupt().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}
const HEARTBEAT_INTERVAL_MS = 15000; // Log heartbeat every 15s if no activity
const MAX_API_ERROR_RETRIES = 3; // Fail after this many consecutive API errors
const MAX_ERROR_DETECTION_LENGTH = 200; // Only check short text chunks for SDK error patterns — longer text is AI analysis content

/** Type for the SDK query function — injectable for testing. */
export type QueryFn = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

const LOGIN_PROBE_TIMEOUT_MS = 8000; // accountInfo() round-trip cap; treat a hang as "not logged in"

/** Probe whether a local Claude Code session is logged in, via the agent SDK's
 * `accountInfo()` control request — the same streaming-input pattern as
 * {@link listModelsViaAgentSdk}: spin up a query whose prompt never yields, issue one
 * control request, then interrupt. Returns `false` on any error or timeout (treated as
 * "not logged in"). Honours the `AGHAST_MOCK_LOCAL_LOGIN` test hook (`true`/`false`)
 * so CLI integration tests stay hermetic without spawning the SDK. */
async function probeLocalLogin(): Promise<boolean> {
  const mock = process.env.AGHAST_MOCK_LOCAL_LOGIN;
  if (mock === 'true') return true;
  if (mock === 'false') return false;

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release: (() => void) | undefined;
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  // eslint-disable-next-line require-yield -- intentional: streaming-input prompt that never yields, kept alive by `block` so `accountInfo()` can run.
  const prompt = (async function* (): AsyncGenerator<never, void, unknown> {
    await block;
    await new Promise<never>(() => {});
  })();
  const q = query({ prompt, options: {} });
  try {
    const info = await Promise.race([
      q.accountInfo(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOGIN_PROBE_TIMEOUT_MS)),
    ]);
    // We only probe when ANTHROPIC_API_KEY is unset, so any populated account/credential
    // field indicates an authenticated local (OAuth) session.
    return !!(info && (info.email || info.subscriptionType || info.tokenSource || info.apiKeySource || info.apiProvider));
  } catch (err) {
    logDebug(TAG, `Local login probe (accountInfo) failed, treating as not logged in: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    release?.();
    await Promise.race([
      q.interrupt().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}

/** Memoized local-login probe — one detection per process run. */
let localLoginProbe: Promise<boolean> | undefined;
function detectLocalLogin(): Promise<boolean> {
  if (!localLoginProbe) {
    localLoginProbe = probeLocalLogin();
  }
  return localLoginProbe;
}

export class ClaudeCodeProvider implements AgentProvider {
  private apiKey: string | undefined;
  private useLocalClaude: boolean = false;
  private model: string = DEFAULT_MODEL;
  private _queryFn: QueryFn | undefined;
  private _detectLocalLogin: () => Promise<boolean>;
  constructor(options?: { _queryFn?: QueryFn; _detectLocalLogin?: () => Promise<boolean> }) {
    this._queryFn = options?._queryFn;
    this._detectLocalLogin = options?._detectLocalLogin ?? detectLocalLogin;
  }

  async checkPrerequisites(): Promise<void> {
    // Auth resolution order: explicit API key → forced local mode → detected local login.
    if (process.env.ANTHROPIC_API_KEY) return;
    if (process.env.AGHAST_LOCAL_CLAUDE === 'true') return;
    if (await this._detectLocalLogin()) return;
    throw new Error(
      'No Claude credentials found. Set ANTHROPIC_API_KEY, or log in to a local Claude session (run `claude` and use /login).',
    );
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    // Model selection priority: config.model (from AGHAST_AI_MODEL env or runtime config) > DEFAULT_MODEL
    if (config.model) {
      this.model = config.model;
    }
    // Local mode when no API key is available: forced via AGHAST_LOCAL_CLAUDE, otherwise
    // auto-detected by probing the local session's login status (memoized, so this reuses
    // any probe already run in checkPrerequisites).
    if (this.apiKey) {
      this.useLocalClaude = false;
    } else if (process.env.AGHAST_LOCAL_CLAUDE === 'true') {
      this.useLocalClaude = true;
    } else {
      this.useLocalClaude = await this._detectLocalLogin();
    }
    if (!this.apiKey && !this.useLocalClaude) {
      throw new Error(
        'ANTHROPIC_API_KEY is required, or log in to a local Claude session (run `claude` and use /login).',
      );
    }
    if (this.useLocalClaude) {
      logProgress(TAG, 'Using local Claude Code session for authentication');
    } else {
      logDebug(TAG, 'Using API key for authentication');
    }
    logDebug(TAG, `Provider initialized with model ${this.model}`);
  }

  /** True when authentication resolved to a local Claude session (no API key). */
  isLocalMode(): boolean {
    return this.useLocalClaude;
  }

  getModelName(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async listModels(): Promise<readonly ProviderModelInfo[]> {
    // Tier 1: if ANTHROPIC_API_KEY is set, hit /v1/models for the full canonical list.
    const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        return await listModelsViaApiKey(apiKey);
      } catch (err) {
        logDebug(TAG, `models.list() via API key failed, falling back to agent-SDK: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Tier 2: ask the Claude Code agent SDK for its curated list (works with local Claude auth).
    return await listModelsViaAgentSdk();
  }

  async executeCheck(
    instructions: string,
    repositoryPath: string,
    logPrefix?: string,
    options?: { maxTurns?: number },
  ): Promise<AgentResponse> {
    const queryFn = this._queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    const timer = createTimer();
    const prefix = logPrefix ? `${logPrefix} ` : '';
    const effectiveMaxTurns = options?.maxTurns ?? 100;

    const prompt = instructions;

    logDebug(TAG, `${prefix}Starting query: model=${this.model}, cwd=${repositoryPath}, promptLen=${prompt.length}, maxTurns=${effectiveMaxTurns}`);
    logDebugFull(TAG, `${prefix}Full prompt sent to AI`, prompt);

    const conversation = queryFn({
      prompt,
      options: {
        model: this.model,
        cwd: repositoryPath,
        allowedTools: ['Read', 'Glob', 'Grep'],
        maxTurns: effectiveMaxTurns,
        permissionMode: 'bypassPermissions',
        outputFormat: {
          type: 'json_schema',
          schema: OUTPUT_SCHEMA,
        },
      },
    });

    // Consume all messages from the async generator to get the result
    let resultText = '';
    let structuredOutput: CheckResponse | undefined;
    let errorMessage: string | undefined;
    let turnCount = 0;
    let toolCallCount = 0;
    let tokenUsage: TokenUsage | undefined;

    let consecutiveApiErrors = 0;
    let currentToolName: string | undefined;
    let lastActivityTime = Date.now();
    const trace = getLogLevel() === 'trace';

    // Background heartbeat timer - logs if no activity for a while
    const heartbeatInterval = setInterval(() => {
      const silentSeconds = Math.round((Date.now() - lastActivityTime) / 1000);
      if (silentSeconds >= HEARTBEAT_INTERVAL_MS / 1000) {
        const status = currentToolName ? `running ${currentToolName}` : 'waiting';
        logDebug(TAG, `${prefix}Still ${status}... (${timer.elapsedStr()})`);
      }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      for await (const message of conversation) {
        lastActivityTime = Date.now();
      // Tool progress events - emitted during long-running tool executions
      if (message.type === 'tool_progress') {
        const progress = message as { tool_name: string; elapsed_time_seconds: number };
        currentToolName = progress.tool_name;
        logDebug(TAG, `${prefix}Running ${progress.tool_name}... (${Math.round(progress.elapsed_time_seconds)}s)`);
      }

      if (message.type === 'assistant') {
        turnCount++;
        currentToolName = undefined;
        // Activity indicator at debug level (scan-runner provides periodic summary at info)
        logDebug(TAG, `${prefix}Turn ${turnCount} (${timer.elapsedStr()})`);

        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          // Count and log tool calls at debug level (compact)
          for (const block of content) {
            if (block?.type === 'tool_use') {
              toolCallCount++;
              currentToolName = block.name;
              const inputStr = JSON.stringify(block.input);
              const inputPreview = inputStr.length > 100 ? inputStr.slice(0, 100) + '...' : inputStr;
              logDebug(TAG, `${prefix}Tool[${toolCallCount}]: ${block.name} ${inputPreview}`);
              if (trace && inputStr.length > 100) logDebugFull(TAG, `${prefix}Full tool call input`, inputStr);
            }
          }

          // Log thinking blocks
          const thinkingBlocks = content.filter((c: any) => c?.type === 'thinking' && typeof c.thinking === 'string').map((c: any) => c.thinking.trim()).filter(Boolean);
          for (const thinking of thinkingBlocks) {
            logDebug(TAG, `${prefix}Thinking: [${thinking.length} chars] ${thinking.slice(0, 100)}...`);
            if (trace) logDebugFull(TAG, `${prefix}Full thinking block`, thinking);
          }

          // Log assistant text at debug level
          const textChunks = content
            .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text.trim())
            .filter(Boolean);
          if (textChunks.length > 0) {
            for (const chunk of textChunks) {
              if (chunk.length > 200) {
                logDebug(TAG, `${prefix}Assistant: [${chunk.length} chars] ${chunk.slice(0, 100)}...`);
                if (trace) logDebugFull(TAG, `${prefix}Full assistant text`, chunk);
              } else {
                logDebug(TAG, `${prefix}Assistant: ${chunk}`);
              }
            }

            // Error detection: only check short text chunks to avoid matching the AI's
            // own analysis text (e.g., a security finding mentioning "rate limiting").
            // SDK/API error messages are typically short (under 200 chars), while AI analysis
            // text is much longer.
            const shortChunks = textChunks.filter((t: string) => t.length < MAX_ERROR_DETECTION_LENGTH);

            // Detect rate-limit messages — fail immediately since retrying won't help.
            const rateLimitMatch = shortChunks.find((t: string) =>
              /you've hit your limit|API Error:\s*429|rate.?limit.?exceeded/i.test(t),
            );
            if (rateLimitMatch) {
              throw new FatalProviderError(`Agent provider rate limit reached: ${rateLimitMatch}`);
            }

            // Detect authentication errors (401) — fail immediately, unrecoverable
            const authErrorMatch = shortChunks.find((t: string) =>
              /API Error:\s*401/i.test(t),
            );
            if (authErrorMatch) {
              throw new FatalProviderError(`Agent provider authentication failed (401): ${authErrorMatch}`);
            }

            // Detect login required — fail immediately, unrecoverable without user action
            const loginRequiredMatch = shortChunks.find((t: string) =>
              /not logged in/i.test(t),
            );
            if (loginRequiredMatch) {
              throw new FatalProviderError(`Agent provider not logged in: ${loginRequiredMatch}. Please authenticate before running scans.`);
            }

            // Detect API errors surfaced as assistant text by the SDK
            const apiErrorMatch = shortChunks.find((t: string) => t.includes('API Error:'));
            if (apiErrorMatch) {
              consecutiveApiErrors++;
              if (consecutiveApiErrors >= MAX_API_ERROR_RETRIES) {
                throw new Error(`Agent provider API error (after ${MAX_API_ERROR_RETRIES} attempts): ${apiErrorMatch}`);
              }
            } else {
              consecutiveApiErrors = 0;
            }
          }
        }
      }

      if (message.type === 'tool_result') {
        const toolResult = message as { tool_use_id?: string; content?: Array<{ type: string; text?: string }> };
        const outputText = toolResult.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') ?? '(no output)';
        const isMultiline = outputText.includes('\n');
        const preview = outputText.length > 300 ? outputText.slice(0, 300) + '...' : outputText;
        if (isMultiline || outputText.length > 300) {
          logDebug(TAG, `${prefix}Tool result [${outputText.length} chars]: ${preview}`);
          if (trace) logDebugFull(TAG, `${prefix}Full tool result`, outputText);
        } else {
          logDebug(TAG, `${prefix}Tool result: ${outputText}`);
        }
      }

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result as string;
          // Extract structured output if available
          const resultMsg = message as {
            result: string;
            structured_output?: CheckResponse;
            total_cost_usd?: number;
            usage?: {
              input_tokens: number;
              output_tokens: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
            modelUsage?: Record<string, {
              inputTokens: number;
              outputTokens: number;
              cacheCreationInputTokens?: number;
              cacheReadInputTokens?: number;
            }>;
          };
          if (resultMsg.structured_output) {
            structuredOutput = resultMsg.structured_output;
            logDebug(TAG, `${prefix}Structured output: ${structuredOutput.issues.length} issues`);
          }
          // Extract token usage if available.
          // Prefer modelUsage (camelCase, per-model breakdown) over usage (snake_case, raw API).
          // Always use total_cost_usd from the result message as the authoritative cost.
          if (resultMsg.modelUsage && Object.keys(resultMsg.modelUsage).length > 0) {
            let inputTokens = 0;
            let outputTokens = 0;
            let cacheCreationInputTokens: number | undefined;
            let cacheReadInputTokens: number | undefined;
            for (const model of Object.values(resultMsg.modelUsage)) {
              inputTokens += model.inputTokens;
              outputTokens += model.outputTokens;
              if (model.cacheCreationInputTokens !== undefined) {
                cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + model.cacheCreationInputTokens;
              }
              if (model.cacheReadInputTokens !== undefined) {
                cacheReadInputTokens = (cacheReadInputTokens ?? 0) + model.cacheReadInputTokens;
              }
            }
            tokenUsage = {
              inputTokens,
              outputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
              totalTokens: inputTokens + outputTokens,
              ...(resultMsg.total_cost_usd !== undefined
                ? { reportedCost: { amountUsd: resultMsg.total_cost_usd, source: 'claude-agent-sdk' as const, ...(this.useLocalClaude ? { coveredBySubscription: true } : {}) } }
                : {}),
            };
            logDebug(TAG, `${prefix}Token usage: ${tokenUsage.inputTokens} in, ${tokenUsage.outputTokens} out, ${cacheReadInputTokens ?? 0} cache-read, ${cacheCreationInputTokens ?? 0} cache-write, $${resultMsg.total_cost_usd ?? 0} reported`);
          } else if (resultMsg.usage) {
            const cacheCreation = resultMsg.usage.cache_creation_input_tokens;
            const cacheRead = resultMsg.usage.cache_read_input_tokens;
            tokenUsage = {
              inputTokens: resultMsg.usage.input_tokens,
              outputTokens: resultMsg.usage.output_tokens,
              ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
              ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
              totalTokens: resultMsg.usage.input_tokens + resultMsg.usage.output_tokens,
              ...(resultMsg.total_cost_usd !== undefined
                ? { reportedCost: { amountUsd: resultMsg.total_cost_usd, source: 'claude-agent-sdk' as const, ...(this.useLocalClaude ? { coveredBySubscription: true } : {}) } }
                : {}),
            };
            logDebug(TAG, `${prefix}Token usage: ${tokenUsage.inputTokens} in, ${tokenUsage.outputTokens} out, ${cacheRead ?? 0} cache-read, ${cacheCreation ?? 0} cache-write, $${resultMsg.total_cost_usd ?? 0} reported`);
          }
          logProgress(TAG, `${prefix}Completed in ${timer.elapsedStr()} (${turnCount} turns, ${toolCallCount} tool calls)`);
        } else {
          const errorResult = message as { subtype: string; errors?: string[] };
          errorMessage = errorResult.errors?.join('; ') ?? `Agent provider error: ${errorResult.subtype}`;
          logProgress(TAG, `${prefix}Failed: ${errorResult.subtype} (${timer.elapsedStr()})`);
        }
      }
    }
    } finally {
      clearInterval(heartbeatInterval);
    }

    if (errorMessage) {
      logDebug(TAG, `${prefix}Error: ${errorMessage}`);
      throw new Error(errorMessage);
    }

    if (!resultText && !structuredOutput && !errorMessage) {
      throw new Error('Agent provider returned no result');
    }

    logDebug(TAG, `${prefix}Result: ${resultText.length} chars`);
    logDebugFull(TAG, `${prefix}Full AI response`, resultText);

    // Structured output from SDK is required - we enforce JSON schema output mode.
    // The response parser (parseAgentResponse) is kept in the codebase as a potential
    // fallback for future use cases (e.g., alternative agent providers that don't support
    // structured output), but this provider always requires structured output.
    if (structuredOutput) {
      return { raw: resultText, parsed: structuredOutput, tokenUsage };
    }

    // No fallback parsing - structured output is mandatory for this provider.
    // If needed in the future, uncomment:
    // const parsed = parseAgentResponse(resultText);
    // return { raw: resultText, parsed: parsed ?? undefined };
    throw new Error('Agent provider did not return structured output');
  }

  async validateConfig(): Promise<boolean> {
    return !!this.apiKey || this.useLocalClaude;
  }
}
