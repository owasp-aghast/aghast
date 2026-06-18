import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeProvider, type QueryFn } from '../src/claude-code-provider.js';
import { FatalProviderError } from '../src/types.js';

/**
 * Build a fake SDK query function that yields the given messages as an async iterable.
 */
function createFakeQueryFn(messages: Record<string, unknown>[]): QueryFn {
  return function* fakeQuery() {
    yield* messages;
  } as unknown as QueryFn;
}

/** Helper: build an assistant message with text content (mimics SDK format). */
function assistantMsg(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

/** Helper: build a successful result message with structured output. */
function successResult(): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: '{"issues":[]}',
    structured_output: { issues: [] },
  };
}

describe('ClaudeCodeProvider: API error handling', () => {
  it('throws after 3 consecutive API error turns', async () => {
    const errorText =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"workspace limits reached"}}';

    const messages = [
      assistantMsg(errorText),
      assistantMsg(errorText),
      assistantMsg(errorText),
      // Should never reach these
      assistantMsg(errorText),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        assert.match(err.message, /Agent provider API error \(after 3 attempts\)/);
        assert.match(err.message, /workspace limits reached/);
        return true;
      },
    );
  });

  it('resets error counter on successful turn and completes normally', async () => {
    const errorText = 'API Error: 500 internal server error';

    const messages = [
      assistantMsg(errorText), // error 1
      assistantMsg(errorText), // error 2
      assistantMsg('Analyzing the codebase...'), // success — resets counter
      assistantMsg(errorText), // error 1 again (counter reset)
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.deepStrictEqual(result.parsed, { issues: [] });
  });

  it('throws after exactly 3 consecutive non-auth API error turns', async () => {
    const errorText = 'API Error: 500 internal server error';

    // Only 3 error messages — should throw on the 3rd
    const messages = [
      assistantMsg(errorText),
      assistantMsg(errorText),
      assistantMsg(errorText),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        assert.match(err.message, /Agent provider API error/);
        assert.match(err.message, /500 internal server error/);
        return true;
      },
    );
  });

  it('throws FatalProviderError immediately on rate limit message', async () => {
    const messages = [
      assistantMsg("You've hit your limit · resets 10pm (Asia/Jerusalem)"),
      // Should never reach these
      assistantMsg('Analyzing the codebase...'),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        assert.ok(err instanceof FatalProviderError, 'Should be FatalProviderError');
        assert.match(err.message, /rate limit reached/i);
        assert.match(err.message, /hit your limit/i);
        return true;
      },
    );
  });

  it('throws FatalProviderError on rate limit message (case-insensitive)', async () => {
    const messages = [
      assistantMsg('Rate limit exceeded, please try again later'),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        assert.ok(err instanceof FatalProviderError, 'Should be FatalProviderError');
        assert.match(err.message, /rate limit reached/i);
        return true;
      },
    );
  });

  it('does not treat non-API-error text as an error', async () => {
    const messages = [
      assistantMsg('Looking at the code...'),
      assistantMsg('Found some potential issues'),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.deepStrictEqual(result.parsed, { issues: [] });
  });

  it('does not treat AI analysis mentioning "rate limit" as a rate limit error', async () => {
    const messages = [
      assistantMsg('**Weak Rate Limiting**: Global rate limit allows 100 requests per 15 minutes - inadequate for password reset. The code uses `crypto.randomBytes(32)` correctly for API keys but uses `Math.random()` for password reset tokens.'),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.deepStrictEqual(result.parsed, { issues: [] });
  });
});

// --- Token usage extraction ---

/** Helper: build a successful result message with modelUsage (camelCase, per-model). */
function successResultWithModelUsage(
  inputTokens: number,
  outputTokens: number,
  model = 'claude-sonnet-4-20250514',
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: '{"issues":[]}',
    structured_output: { issues: [] },
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      [model]: { inputTokens, outputTokens },
    },
  };
}

/** Helper: build a successful result message with only usage (snake_case, raw API). */
function successResultWithUsageOnly(
  input_tokens: number,
  output_tokens: number,
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: '{"issues":[]}',
    structured_output: { issues: [] },
    usage: { input_tokens, output_tokens },
  };
}

describe('ClaudeCodeProvider: token usage extraction', () => {
  it('extracts token usage from modelUsage (preferred, camelCase)', async () => {
    const messages = [
      assistantMsg('Analyzing...'),
      successResultWithModelUsage(500, 200),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.inputTokens, 500);
    assert.equal(result.tokenUsage!.outputTokens, 200);
    assert.equal(result.tokenUsage!.totalTokens, 700);
  });

  it('sums token usage across multiple models in modelUsage', async () => {
    const messages = [
      assistantMsg('Analyzing...'),
      {
        type: 'result',
        subtype: 'success',
        result: '{"issues":[]}',
        structured_output: { issues: [] },
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          'claude-sonnet-4-20250514': { inputTokens: 300, outputTokens: 100 },
          'claude-haiku-3-20240307': { inputTokens: 200, outputTokens: 50 },
        },
      },
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.inputTokens, 500);
    assert.equal(result.tokenUsage!.outputTokens, 150);
    assert.equal(result.tokenUsage!.totalTokens, 650);
  });

  it('falls back to usage (snake_case) when modelUsage is absent', async () => {
    const messages = [
      assistantMsg('Analyzing...'),
      successResultWithUsageOnly(500, 200),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.inputTokens, 500);
    assert.equal(result.tokenUsage!.outputTokens, 200);
    assert.equal(result.tokenUsage!.totalTokens, 700);
  });

  it('tokenUsage is undefined when SDK result has no usage field', async () => {
    const messages = [
      assistantMsg('Analyzing...'),
      successResult(), // no usage field
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.equal(result.tokenUsage, undefined, 'Should not have tokenUsage');
  });

  it('extracts cache tokens and total_cost_usd from modelUsage result', async () => {
    const messages = [
      assistantMsg('Analyzing...'),
      {
        type: 'result',
        subtype: 'success',
        result: '{"issues":[]}',
        structured_output: { issues: [] },
        total_cost_usd: 0.0123,
        modelUsage: {
          'claude-sonnet-4-20250514': {
            inputTokens: 1000,
            outputTokens: 200,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 8000,
          },
        },
      },
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.inputTokens, 1000);
    assert.equal(result.tokenUsage!.outputTokens, 200);
    assert.equal(result.tokenUsage!.cacheCreationInputTokens, 500);
    assert.equal(result.tokenUsage!.cacheReadInputTokens, 8000);
    assert.ok(result.tokenUsage!.reportedCost, 'Should have reportedCost');
    assert.equal(result.tokenUsage!.reportedCost!.amountUsd, 0.0123);
    assert.equal(result.tokenUsage!.reportedCost!.source, 'claude-agent-sdk');
  });

  it('extracts cache tokens and total_cost_usd from usage (snake_case) fallback', async () => {
    const messages = [
      assistantMsg('Analyzing...'),
      {
        type: 'result',
        subtype: 'success',
        result: '{"issues":[]}',
        structured_output: { issues: [] },
        total_cost_usd: 0.0456,
        usage: {
          input_tokens: 2000,
          output_tokens: 300,
          cache_creation_input_tokens: 600,
          cache_read_input_tokens: 9000,
        },
      },
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.inputTokens, 2000);
    assert.equal(result.tokenUsage!.outputTokens, 300);
    assert.equal(result.tokenUsage!.cacheCreationInputTokens, 600);
    assert.equal(result.tokenUsage!.cacheReadInputTokens, 9000);
    assert.ok(result.tokenUsage!.reportedCost, 'Should have reportedCost');
    assert.equal(result.tokenUsage!.reportedCost!.amountUsd, 0.0456);
    assert.equal(result.tokenUsage!.reportedCost!.source, 'claude-agent-sdk');
  });

  it('does not set reportedCost when total_cost_usd is absent', async () => {
    const messages = [
      assistantMsg('Analyzing...'),
      successResultWithModelUsage(100, 50),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.reportedCost, undefined);
  });

  it('sets reportedCost.coveredBySubscription when AGHAST_LOCAL_CLAUDE=true', async () => {
    const savedEnv = process.env.AGHAST_LOCAL_CLAUDE;
    process.env.AGHAST_LOCAL_CLAUDE = 'true';
    try {
      const messages = [
        assistantMsg('Analyzing...'),
        {
          type: 'result',
          subtype: 'success',
          result: '{"issues":[]}',
          structured_output: { issues: [] },
          total_cost_usd: 0.0500,
          modelUsage: {
            'claude-sonnet-4-20250514': { inputTokens: 1000, outputTokens: 200 },
          },
        },
      ];

      const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
      await provider.initialize({});

      const result = await provider.executeCheck('test prompt', '/tmp/repo');
      assert.ok(result.tokenUsage?.reportedCost, 'Should have reportedCost');
      assert.equal(result.tokenUsage!.reportedCost!.amountUsd, 0.0500);
      assert.equal(result.tokenUsage!.reportedCost!.source, 'claude-agent-sdk');
      assert.equal(result.tokenUsage!.reportedCost!.coveredBySubscription, true);
    } finally {
      if (savedEnv === undefined) {
        delete process.env.AGHAST_LOCAL_CLAUDE;
      } else {
        process.env.AGHAST_LOCAL_CLAUDE = savedEnv;
      }
    }
  });
});

describe('ClaudeCodeProvider: fatal error handling (401 auth)', () => {
  it('throws FatalProviderError immediately on 401 auth error', async () => {
    const errorText = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

    const messages = [
      assistantMsg(errorText),
      // Should never reach these
      assistantMsg(errorText),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        assert.ok(err instanceof FatalProviderError, 'Should be FatalProviderError');
        assert.match(err.message, /authentication failed.*401/i);
        return true;
      },
    );
  });

  it('throws FatalProviderError on 401 even with prefix text (realistic SDK format)', async () => {
    const errorText =
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}';

    const messages = [
      assistantMsg(errorText),
      // Should never reach these
      assistantMsg(errorText),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        assert.ok(err instanceof FatalProviderError, 'Should be FatalProviderError');
        assert.match(err.message, /authentication failed.*401/i);
        assert.match(err.message, /OAuth token has expired/);
        return true;
      },
    );
  });

  it('non-401 API errors with prefix text are detected via includes', async () => {
    const errorText = 'Something went wrong. API Error: 500 internal server error';

    const messages = [
      assistantMsg(errorText),
      assistantMsg(errorText),
      assistantMsg(errorText),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        // Should be a regular Error (not FatalProviderError) since it's not a 401
        assert.ok(!(err instanceof FatalProviderError), 'Should NOT be FatalProviderError for 500');
        assert.match(err.message, /Agent provider API error \(after 3 attempts\)/);
        assert.match(err.message, /500 internal server error/);
        return true;
      },
    );
  });
});

describe('ClaudeCodeProvider: fatal error handling (not logged in)', () => {
  it('throws FatalProviderError immediately on "Not logged in" message', async () => {
    const messages = [
      assistantMsg('Not logged in · Please run /login'),
      // Should never reach these
      assistantMsg('This should not be reached'),
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    await assert.rejects(
      () => provider.executeCheck('test prompt', '/tmp/repo'),
      (err: Error) => {
        assert.ok(err instanceof FatalProviderError, 'Should be FatalProviderError');
        assert.match(err.message, /not logged in/i);
        return true;
      },
    );
  });
});

describe('ClaudeCodeProvider: tool restrictions', () => {
  it('passes only read-only tools in allowedTools', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const capturingQueryFn: QueryFn = function* (params) {
      capturedOptions = params.options as Record<string, unknown>;
      yield successResult();
    } as unknown as QueryFn;

    const provider = new ClaudeCodeProvider({ _queryFn: capturingQueryFn });
    await provider.initialize({ apiKey: 'test-key' });
    await provider.executeCheck('test prompt', '/tmp/repo');

    assert.deepEqual(capturedOptions?.allowedTools, ['Read', 'Glob', 'Grep']);
  });
});

describe('ClaudeCodeProvider: thinking blocks and tool_result handling', () => {
  it('handles thinking blocks in assistant messages without crashing', async () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me analyze the security implications of this code...' },
            { type: 'text', text: 'I found a potential issue.' },
          ],
        },
      },
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.deepStrictEqual(result.parsed, { issues: [] });
  });

  it('handles thinking blocks alongside tool_use in the same turn', async () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'I should read the file first.' },
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/tmp/repo/src/index.ts' } },
          ],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: [{ type: 'text', text: 'const x = 1;' }],
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Analysis complete.' }],
        },
      },
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.deepStrictEqual(result.parsed, { issues: [] });
  });

  it('handles tool_result messages in the stream without crashing', async () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Grep', input: { pattern: 'eval', path: '/tmp/repo' } },
          ],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: [{ type: 'text', text: 'src/index.ts:5: eval(userInput)' }],
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Found a potential eval injection.' }],
        },
      },
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.deepStrictEqual(result.parsed, { issues: [] });
  });

  it('handles thinking blocks without tool_use in the same content array', async () => {
    // Before the scope fix, thinking blocks only fired inside the tool_use if-block,
    // so a turn with only thinking + text (no tool_use) would silently skip them.
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'No tools needed, I can answer directly.' },
            { type: 'text', text: 'The code looks safe.' },
          ],
        },
      },
      successResult(),
    ];

    const provider = new ClaudeCodeProvider({ _queryFn: createFakeQueryFn(messages) });
    await provider.initialize({ apiKey: 'test-key' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.deepStrictEqual(result.parsed, { issues: [] });
  });
});

describe('ClaudeCodeProvider: authentication resolution', () => {
  /** Run `fn` with ANTHROPIC_API_KEY / AGHAST_LOCAL_CLAUDE set to the given values, restoring after. */
  async function withAuthEnv(
    env: { ANTHROPIC_API_KEY?: string; AGHAST_LOCAL_CLAUDE?: string },
    fn: () => Promise<void>,
  ): Promise<void> {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      AGHAST_LOCAL_CLAUDE: process.env.AGHAST_LOCAL_CLAUDE,
    };
    const apply = (k: 'ANTHROPIC_API_KEY' | 'AGHAST_LOCAL_CLAUDE', v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    apply('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
    apply('AGHAST_LOCAL_CLAUDE', env.AGHAST_LOCAL_CLAUDE);
    try {
      await fn();
    } finally {
      apply('ANTHROPIC_API_KEY', saved.ANTHROPIC_API_KEY);
      apply('AGHAST_LOCAL_CLAUDE', saved.AGHAST_LOCAL_CLAUDE);
    }
  }

  it('checkPrerequisites passes when ANTHROPIC_API_KEY is set, without probing local login', async () => {
    await withAuthEnv({ ANTHROPIC_API_KEY: 'test-key', AGHAST_LOCAL_CLAUDE: undefined }, async () => {
      let probed = false;
      const provider = new ClaudeCodeProvider({
        _detectLocalLogin: async () => {
          probed = true;
          return false;
        },
      });
      await provider.checkPrerequisites();
      assert.equal(probed, false, 'should not probe local login when an API key is present');
    });
  });

  it('checkPrerequisites passes when AGHAST_LOCAL_CLAUDE=true, without probing local login', async () => {
    await withAuthEnv({ ANTHROPIC_API_KEY: undefined, AGHAST_LOCAL_CLAUDE: 'true' }, async () => {
      let probed = false;
      const provider = new ClaudeCodeProvider({
        _detectLocalLogin: async () => {
          probed = true;
          return false;
        },
      });
      await provider.checkPrerequisites();
      assert.equal(probed, false, 'forced local mode should not probe');
    });
  });

  it('checkPrerequisites passes when local login is detected (no key, not forced)', async () => {
    await withAuthEnv({ ANTHROPIC_API_KEY: undefined, AGHAST_LOCAL_CLAUDE: undefined }, async () => {
      const provider = new ClaudeCodeProvider({ _detectLocalLogin: async () => true });
      await provider.checkPrerequisites();
    });
  });

  it('checkPrerequisites throws when no key, not forced, and not logged in', async () => {
    await withAuthEnv({ ANTHROPIC_API_KEY: undefined, AGHAST_LOCAL_CLAUDE: undefined }, async () => {
      const provider = new ClaudeCodeProvider({ _detectLocalLogin: async () => false });
      await assert.rejects(
        () => provider.checkPrerequisites(),
        /No Claude credentials|ANTHROPIC_API_KEY/,
      );
    });
  });

  it('initialize enters local mode (coveredBySubscription) when local login is detected', async () => {
    await withAuthEnv({ ANTHROPIC_API_KEY: undefined, AGHAST_LOCAL_CLAUDE: undefined }, async () => {
      const messages = [
        assistantMsg('Analyzing...'),
        {
          type: 'result',
          subtype: 'success',
          result: '{"issues":[]}',
          structured_output: { issues: [] },
          total_cost_usd: 0.0500,
          modelUsage: {
            'claude-sonnet-4-20250514': { inputTokens: 1000, outputTokens: 200 },
          },
        },
      ];
      const provider = new ClaudeCodeProvider({
        _queryFn: createFakeQueryFn(messages),
        _detectLocalLogin: async () => true,
      });
      await provider.initialize({});

      const result = await provider.executeCheck('test prompt', '/tmp/repo');
      assert.ok(result.tokenUsage?.reportedCost, 'Should have reportedCost');
      assert.equal(result.tokenUsage!.reportedCost!.coveredBySubscription, true);
    });
  });
});

