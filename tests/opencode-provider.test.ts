/**
 * Unit tests for the OpenCode agent provider.
 * Uses constructor DI (_client) to inject a mock OpenCode client.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeProvider } from '../src/opencode-provider.js';
import { FatalProviderError } from '../src/types.js';
import { addHandler, removeHandler, type LogEntry, type LogHandler } from '../src/logging.js';

/** Accessor for the provider's private marker methods/state in tests. */
interface MarkerInternals {
  skipProjectMarker: boolean;
  createdMarkers: Map<string, number>;
  ensureProjectMarker(path: string): Promise<void>;
  releaseProjectMarker(path: string): Promise<void>;
  cleanupMarkersSync(): void;
}
function internals(p: OpenCodeProvider): MarkerInternals {
  return p as unknown as MarkerInternals;
}

// --- Mock client builder ---

interface MockModel {
  name: string;
}

interface MockProvider {
  id: string;
  name: string;
  models: Record<string, MockModel>;
}

interface PromptCall {
  sessionID: string;
  model: { providerID: string; modelID: string };
  parts: Array<{ type: string; text: string }>;
  format?: unknown;
  directory?: string;
}

/**
 * Create a mock OpenCode client for testing.
 *
 * The mock simulates the synchronous prompt flow with background polling:
 * - session.prompt() blocks and returns the final response
 * - session.messages() returns messages for progress polling
 */
const DEFAULT_MOCK_TOOL_IDS = ['read', 'glob', 'grep', 'list', 'bash', 'edit', 'webfetch', 'websearch'];

/** Seed events for the SSE mock stream. */
type SseEvent = { type: string; properties: Record<string, unknown> };

function createMockClient(options?: {
  providers?: MockProvider[];
  promptResponse?: {
    info?: Record<string, unknown>;
    parts?: Array<{ type: string; text?: string }>;
  };
  toolIds?: string[];
  sseEvents?: SseEvent[];
}) {
  const providers = options?.providers ?? [
    {
      id: 'test-provider',
      name: 'Test Provider',
      models: {
        'test-model': { name: 'Test Model' },
        'other-model': { name: 'Other Model' },
      },
    },
  ];

  const defaultPromptResponse = options?.promptResponse ?? {
    info: {
      role: 'assistant',
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      structured: { issues: [] },
    },
    parts: [{ type: 'text', text: '{"issues": []}' }],
  };

  const toolIds = options?.toolIds ?? DEFAULT_MOCK_TOOL_IDS;
  const sseEvents = options?.sseEvents ?? [];

  const calls: {
    sessionCreate: Array<Record<string, unknown>>;
    prompt: PromptCall[];
  } = { sessionCreate: [], prompt: [] };

  let sessionCounter = 0;

  const client = {
    config: {
      providers: async () => ({
        data: { providers },
      }),
    },
    tool: {
      ids: async () => ({ data: toolIds }),
    },
    session: {
      create: async (params: Record<string, unknown>) => {
        calls.sessionCreate.push(params);
        sessionCounter++;
        return { data: { id: `session-${sessionCounter}` } };
      },
      prompt: async (params: PromptCall) => {
        calls.prompt.push(params);
        return { data: defaultPromptResponse };
      },
      messages: async () => ({
        data: [
          { info: { role: 'user' }, parts: [] },
          { info: { role: 'assistant' }, parts: defaultPromptResponse.parts ?? [] },
        ],
      }),
    },
    event: {
      subscribe: async (_params?: unknown, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        async function* makeStream() {
          for (const evt of sseEvents) {
            if (signal?.aborted) return;
            yield evt;
          }
          // After seeded events are exhausted, block until aborted so the SSE task
          // mirrors real server behaviour (stream stays open until the caller aborts).
          // Check signal.aborted first — abort() may have been called before we reach
          // this point (signal already set when addEventListener would be registered,
          // and AbortSignal does not re-fire already-dispatched events).
          if (!signal || signal.aborted) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return { stream: makeStream() };
      },
    },
    calls,
  };

  return client as unknown as typeof client;
}

// --- Tests ---

describe('OpenCodeProvider — model parsing', () => {
  it('parses providerID/modelID correctly', async () => {
    const client = createMockClient();
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });
    assert.equal(provider.getModelName(), 'test-provider/test-model');
  });

  it('defaults to opencode/hy3-preview-free when no model specified', async () => {
    const client = createMockClient({
      providers: [{ id: 'opencode', name: 'OpenCode', models: { 'hy3-preview-free': { name: 'HY3 Preview Free' } } }],
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({});
    assert.equal(provider.getModelName(), 'opencode/hy3-preview-free');
  });

  it('throws on model string without slash', async () => {
    const client = createMockClient();
    const provider = new OpenCodeProvider({ _client: client as never });
    await assert.rejects(
      () => provider.initialize({ model: 'no-slash-model' }),
      /Invalid model format.*Expected "providerID\/modelID"/,
    );
  });

  it('setModel updates providerID and modelID', async () => {
    const client = createMockClient({
      providers: [
        { id: 'test-provider', name: 'Test', models: { 'test-model': { name: 'Test' } } },
        { id: 'other', name: 'Other', models: { 'model-x': { name: 'X' } } },
      ],
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });
    provider.setModel('other/model-x');
    assert.equal(provider.getModelName(), 'other/model-x');
  });
});

describe('OpenCodeProvider — model validation', () => {
  it('throws FatalProviderError for unknown provider', async () => {
    const client = createMockClient({
      providers: [{ id: 'real-provider', name: 'Real', models: { m1: { name: 'M1' } } }],
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await assert.rejects(
      () => provider.initialize({ model: 'fake-provider/some-model' }),
      (err: unknown) => {
        assert.ok(err instanceof FatalProviderError);
        assert.ok(err.message.includes('fake-provider'));
        assert.ok(err.message.includes('real-provider'));
        return true;
      },
    );
  });

  it('throws FatalProviderError for unknown model', async () => {
    const client = createMockClient({
      providers: [{ id: 'test-provider', name: 'Test', models: { 'valid-model': { name: 'Valid' } } }],
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await assert.rejects(
      () => provider.initialize({ model: 'test-provider/invalid-model' }),
      (err: unknown) => {
        assert.ok(err instanceof FatalProviderError);
        assert.ok(err.message.includes('invalid-model'));
        assert.ok(err.message.includes('test-provider/valid-model'));
        return true;
      },
    );
  });

  it('accepts valid provider and model', async () => {
    const client = createMockClient();
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });
    assert.equal(provider.getModelName(), 'test-provider/test-model');
  });
});

describe('OpenCodeProvider — executeCheck', () => {
  it('creates session and sends prompt with correct parameters', async () => {
    const client = createMockClient();
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await provider.executeCheck('test instructions', '/repo/path');

    assert.equal(client.calls.sessionCreate.length, 1);
    assert.equal(client.calls.sessionCreate[0].directory, '/repo/path');
    // Dynamic allowlist: DEFAULT_MOCK_TOOL_IDS minus the allowed set (read, glob, grep, list)
    assert.deepEqual(client.calls.sessionCreate[0].permission, [
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'webfetch', pattern: '*', action: 'deny' },
      { permission: 'websearch', pattern: '*', action: 'deny' },
    ]);

    assert.equal(client.calls.prompt.length, 1);
    const promptCall = client.calls.prompt[0];
    assert.equal(promptCall.sessionID, 'session-1');
    assert.deepEqual(promptCall.model, { providerID: 'test-provider', modelID: 'test-model' });
    assert.equal(promptCall.parts[0].text, 'test instructions');
    assert.deepEqual(promptCall.format, { type: 'json_schema', schema: expect_output_schema() });
    assert.equal(promptCall.directory, '/repo/path');
  });

  it('returns structured output when available', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          structured: {
            issues: [
              { file: 'app.js', startLine: 10, endLine: 15, description: 'SQL injection' },
            ],
          },
        },
        parts: [{ type: 'text', text: 'some text' }],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    const result = await provider.executeCheck('find vulns', '/repo');

    assert.ok(result.parsed);
    assert.equal(result.parsed.issues.length, 1);
    assert.equal(result.parsed.issues[0].file, 'app.js');
    assert.equal(result.parsed.issues[0].description, 'SQL injection');
    assert.ok(result.tokenUsage);
    assert.equal(result.tokenUsage!.inputTokens, 200);
    assert.equal(result.tokenUsage!.outputTokens, 100);
    assert.equal(result.tokenUsage!.totalTokens, 300);
  });

  it('falls back to text parsing when no structured output', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          tokens: { input: 50, output: 25, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ type: 'text', text: '{"issues": [{"file": "x.py", "startLine": 1, "endLine": 2, "description": "test"}]}' }],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    const result = await provider.executeCheck('find vulns', '/repo');

    assert.ok(result.parsed);
    assert.equal(result.parsed.issues.length, 1);
    assert.equal(result.parsed.issues[0].file, 'x.py');
  });

  it('throws when no text response and no structured output', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await assert.rejects(
      () => provider.executeCheck('find vulns', '/repo'),
      /no text response/,
    );
  });

  it('denies all tools not in the allowlist (dynamic virtual allowlist)', async () => {
    const client = createMockClient({
      toolIds: ['read', 'glob', 'grep', 'list', 'bash', 'edit', 'webfetch', 'mcp_custom_tool'],
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await provider.executeCheck('test', '/repo');

    assert.deepEqual(client.calls.sessionCreate[0].permission, [
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'webfetch', pattern: '*', action: 'deny' },
      { permission: 'mcp_custom_tool', pattern: '*', action: 'deny' },
    ]);
  });

  it('creates session without permission rules when tool.ids() fails', async () => {
    const client = createMockClient();
    client.tool.ids = async () => { throw new Error('endpoint unavailable'); };
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await provider.executeCheck('test', '/repo');

    assert.equal(client.calls.sessionCreate[0].permission, undefined);
  });

  it('throws Error on session creation failure', async () => {
    const client = createMockClient();
    client.session.create = async () => ({ data: { id: undefined as unknown as string } });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await assert.rejects(
      () => provider.executeCheck('test', '/repo'),
      /no session ID/,
    );
  });
});

describe('OpenCodeProvider — error handling', () => {
  it('throws FatalProviderError on ProviderAuthError', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          error: { name: 'ProviderAuthError', data: { providerID: 'test', message: 'Invalid API key' } },
        },
        parts: [],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await assert.rejects(
      () => provider.executeCheck('test', '/repo'),
      (err: unknown) => {
        assert.ok(err instanceof FatalProviderError);
        assert.ok(err.message.includes('authentication failed'));
        return true;
      },
    );
  });

  it('throws FatalProviderError on rate limit APIError', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          error: { name: 'APIError', data: { message: 'rate limit exceeded 429' } },
        },
        parts: [],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await assert.rejects(
      () => provider.executeCheck('test', '/repo'),
      (err: unknown) => {
        assert.ok(err instanceof FatalProviderError);
        assert.ok(err.message.includes('rate limit'));
        return true;
      },
    );
  });

  it('throws regular Error on non-fatal API errors', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          error: { name: 'UnknownError', data: { message: 'something broke' } },
        },
        parts: [],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await assert.rejects(
      () => provider.executeCheck('test', '/repo'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof FatalProviderError));
        assert.ok(err.message.includes('UnknownError'));
        return true;
      },
    );
  });
});

describe('OpenCodeProvider — SSE event stream', () => {
  it('surfaces session.error events at warn level regardless of log level', async () => {
    const warnMessages: string[] = [];
    const spy: LogHandler = {
      name: 'test-warn-spy',
      level: 'warn',
      handle(entry: LogEntry) {
        if (entry.level === 'warn') warnMessages.push(entry.message);
      },
      close: async () => {},
    };
    addHandler(spy);

    try {
      // Capture the session ID dynamically from the mock's session.create so the
      // SSE event's sessionID matches what the provider actually uses, without
      // hardcoding mock internals.
      let capturedSessionId = '';
      const pendingEvents: SseEvent[] = [];
      const client = createMockClient({ sseEvents: pendingEvents });
      const origCreate = client.session.create;
      client.session.create = async (params: Record<string, unknown>) => {
        const result = await origCreate(params);
        capturedSessionId = (result.data?.id as string) ?? '';
        // Seed the event now that we know the session ID.
        pendingEvents.push({
          type: 'session.error',
          properties: {
            sessionID: capturedSessionId,
            error: { name: 'UnknownError', data: { message: 'Model not found: provider/model.' } },
          },
        });
        return result;
      };

      const provider = new OpenCodeProvider({ _client: client as never });
      await provider.initialize({ model: 'test-provider/test-model' });

      await provider.executeCheck('test instructions', '/repo/path');

      assert.ok(capturedSessionId !== '', 'Expected session.create to have been called');
      assert.ok(
        warnMessages.some((m) => m.includes('Model not found: provider/model.')),
        `Expected a warn log containing the session.error message. Got: ${JSON.stringify(warnMessages)}`,
      );
    } finally {
      removeHandler('test-warn-spy');
    }
  });
});

describe('OpenCodeProvider — cleanup', () => {
  it('cleanup is idempotent', async () => {
    const client = createMockClient();
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    await provider.cleanup();
    await provider.cleanup();
  });

  it('validateConfig returns false before initialize', async () => {
    const provider = new OpenCodeProvider();
    const result = await provider.validateConfig();
    assert.equal(result, false);
  });

  it('validateConfig returns true after initialize', async () => {
    const client = createMockClient();
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });
    const result = await provider.validateConfig();
    assert.equal(result, true);
  });

  it('checkPrerequisites does not throw', () => {
    const provider = new OpenCodeProvider();
    provider.checkPrerequisites();
  });

});

describe('OpenCodeProvider — listModels', () => {
  it('flattens provider.models into providerID/modelID entries', async () => {
    const client = createMockClient({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-sonnet-4-20250514': { name: 'Claude Sonnet 4' },
            'claude-opus-4-20250514': { name: 'Claude Opus 4' },
          },
        },
        {
          id: 'openai',
          name: 'OpenAI',
          models: { 'gpt-4o': { name: 'GPT-4o' } },
        },
      ],
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'anthropic/claude-sonnet-4-20250514' });

    const models = await provider.listModels();
    assert.deepEqual(
      models.map((m) => m.id).sort(),
      ['anthropic/claude-opus-4-20250514', 'anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o'],
    );
    const sonnet = models.find((m) => m.id === 'anthropic/claude-sonnet-4-20250514')!;
    assert.equal(sonnet.label, 'Claude Sonnet 4');
    assert.equal(sonnet.description, 'Anthropic');
  });

  it('falls back to modelID when model has no name', async () => {
    const client = createMockClient({
      providers: [{ id: 'p1', name: 'P1', models: { 'unnamed': {} as { name?: string } } }],
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'p1/unnamed' });

    const models = await provider.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].label, 'unnamed');
  });

  it('returns empty list when no providers configured', async () => {
    const client = createMockClient({ providers: [] });
    const provider = new OpenCodeProvider({ _client: client as never });
    // Can't call initialize with empty providers — the default model validation would fail.
    // Manually wire up the provider for this edge case.
    (provider as unknown as { _client: unknown })._client = client;

    const models = await provider.listModels();
    assert.deepEqual(models, []);
  });

  it('throws when called before initialize', async () => {
    const provider = new OpenCodeProvider();
    await assert.rejects(() => provider.listModels(), /not initialized/);
  });
});

describe('OpenCodeProvider — project marker', () => {
  let rootTmp: string;
  before(() => {
    rootTmp = mkdtempSync(join(tmpdir(), 'aghast-marker-'));
  });
  after(() => {
    try { rmSync(rootTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function freshDir(name: string): string {
    const p = join(rootTmp, name + '-' + Math.random().toString(36).slice(2, 8));
    mkdirSync(p, { recursive: true });
    return p;
  }

  function makeProvider(): OpenCodeProvider {
    // Inject a minimal fake client so initialize-style state isn't needed; then
    // flip skipProjectMarker off so marker logic runs against the real filesystem.
    const p = new OpenCodeProvider({ _client: {} as never });
    internals(p).skipProjectMarker = false;
    return p;
  }

  it('creates .git when absent and tracks it via refcount', async () => {
    const dir = freshDir('create');
    const p = makeProvider();
    await internals(p).ensureProjectMarker(dir);
    assert.ok(existsSync(join(dir, '.git')), '.git should have been created');
    assert.equal(internals(p).createdMarkers.get(dir), 1);
  });

  it('does not touch pre-existing .git and does not add a refcount entry', async () => {
    const dir = freshDir('preexisting');
    mkdirSync(join(dir, '.git'));
    const p = makeProvider();
    await internals(p).ensureProjectMarker(dir);
    assert.ok(existsSync(join(dir, '.git')), 'pre-existing .git should remain');
    assert.equal(
      internals(p).createdMarkers.has(dir),
      false,
      'pre-existing markers must not be tracked — we would otherwise delete what we did not create',
    );
  });

  it('refcount increments for parallel ensures on the same path and only removes on last release', async () => {
    const dir = freshDir('refcount');
    const p = makeProvider();
    await internals(p).ensureProjectMarker(dir);
    await internals(p).ensureProjectMarker(dir);
    await internals(p).ensureProjectMarker(dir);
    assert.equal(internals(p).createdMarkers.get(dir), 3);

    await internals(p).releaseProjectMarker(dir);
    assert.equal(internals(p).createdMarkers.get(dir), 2);
    assert.ok(existsSync(join(dir, '.git')), '.git must persist while refcount > 0');

    await internals(p).releaseProjectMarker(dir);
    assert.equal(internals(p).createdMarkers.get(dir), 1);
    assert.ok(existsSync(join(dir, '.git')));

    await internals(p).releaseProjectMarker(dir);
    assert.equal(internals(p).createdMarkers.has(dir), false);
    assert.equal(existsSync(join(dir, '.git')), false, '.git should be removed after last release');
  });

  it('release on a path we never created is a no-op (does not delete pre-existing .git)', async () => {
    const dir = freshDir('release-foreign');
    mkdirSync(join(dir, '.git'));
    const p = makeProvider();
    await internals(p).ensureProjectMarker(dir); // no-op (pre-existing), no refcount
    await internals(p).releaseProjectMarker(dir); // no-op
    assert.ok(existsSync(join(dir, '.git')), 'pre-existing .git must not be deleted by release');
  });

  it('concurrent ensureProjectMarker calls serialize via mutex (no double-create, correct refcount)', async () => {
    const dir = freshDir('concurrent');
    const p = makeProvider();
    await Promise.all([
      internals(p).ensureProjectMarker(dir),
      internals(p).ensureProjectMarker(dir),
      internals(p).ensureProjectMarker(dir),
      internals(p).ensureProjectMarker(dir),
      internals(p).ensureProjectMarker(dir),
    ]);
    assert.equal(internals(p).createdMarkers.get(dir), 5);
    assert.ok(existsSync(join(dir, '.git')));

    await Promise.all([
      internals(p).releaseProjectMarker(dir),
      internals(p).releaseProjectMarker(dir),
      internals(p).releaseProjectMarker(dir),
      internals(p).releaseProjectMarker(dir),
      internals(p).releaseProjectMarker(dir),
    ]);
    assert.equal(internals(p).createdMarkers.has(dir), false);
    assert.equal(existsSync(join(dir, '.git')), false);
  });

  it('cleanupMarkersSync wipes every tracked marker and clears the map', async () => {
    const dirA = freshDir('sync-a');
    const dirB = freshDir('sync-b');
    const p = makeProvider();
    await internals(p).ensureProjectMarker(dirA);
    await internals(p).ensureProjectMarker(dirB);
    assert.ok(existsSync(join(dirA, '.git')));
    assert.ok(existsSync(join(dirB, '.git')));

    internals(p).cleanupMarkersSync();
    assert.equal(existsSync(join(dirA, '.git')), false);
    assert.equal(existsSync(join(dirB, '.git')), false);
    assert.equal(internals(p).createdMarkers.size, 0);
  });

  it('is a no-op when skipProjectMarker is true (injected-client test mode)', async () => {
    const dir = freshDir('skip');
    const p = new OpenCodeProvider({ _client: {} as never });
    // Default: skipProjectMarker=true because a _client was injected.
    assert.equal(internals(p).skipProjectMarker, true);
    await internals(p).ensureProjectMarker(dir);
    assert.equal(existsSync(join(dir, '.git')), false, 'should not have created .git in skip mode');
    assert.equal(internals(p).createdMarkers.size, 0);
  });

  it('non-fatal on git init failure: logs but does not throw, no refcount entry', async () => {
    const p = makeProvider();
    // Non-existent directory — `git init` can't cwd there.
    const badDir = join(rootTmp, 'does-not-exist-' + Math.random().toString(36).slice(2));
    await internals(p).ensureProjectMarker(badDir); // should not throw
    assert.equal(
      internals(p).createdMarkers.has(badDir),
      false,
      'failed inits must not leave a phantom refcount (would cause release to try rm on nothing)',
    );
  });
});

describe('OpenCodeProvider — project marker integration with executeCheck', () => {
  let rootTmp: string;
  beforeEach(() => {
    rootTmp = mkdtempSync(join(tmpdir(), 'aghast-marker-exec-'));
  });
  afterEach(() => {
    try { rmSync(rootTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('creates and removes .git around a single executeCheck call', async () => {
    const dir = join(rootTmp, 'scan-target');
    mkdirSync(dir);

    const client = createMockClient();
    const provider = new OpenCodeProvider({ _client: client as never });
    internals(provider).skipProjectMarker = false; // opt-in: exercise real marker logic
    await provider.initialize({ model: 'test-provider/test-model' });

    assert.equal(existsSync(join(dir, '.git')), false, 'starts without .git');
    await provider.executeCheck('test instructions', dir);
    assert.equal(
      existsSync(join(dir, '.git')),
      false,
      '.git must be removed after executeCheck finishes',
    );
  });

  it('cleans up marker even when the session prompt throws', async () => {
    const dir = join(rootTmp, 'scan-throws');
    mkdirSync(dir);

    const client = createMockClient();
    // Override prompt to throw
    client.session.prompt = async () => { throw new Error('simulated prompt failure'); };

    const provider = new OpenCodeProvider({ _client: client as never });
    internals(provider).skipProjectMarker = false;
    await provider.initialize({ model: 'test-provider/test-model' });

    await assert.rejects(() => provider.executeCheck('test', dir), /simulated prompt failure/);
    assert.equal(
      existsSync(join(dir, '.git')),
      false,
      '.git should have been cleaned up even on failure',
    );
  });
});

// Helper to get the expected OUTPUT_SCHEMA shape for assertion
function expect_output_schema() {
  return {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' },
            description: { type: 'string' },
            dataFlow: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  lineNumber: { type: 'integer' },
                  label: { type: 'string' },
                },
                required: ['file', 'lineNumber', 'label'],
                additionalProperties: false,
              },
            },
          },
          required: ['file', 'startLine', 'endLine', 'description'],
          additionalProperties: false,
        },
      },
      verdict: { type: 'string', enum: ['true-positive', 'false-positive'] },
      rationale: { type: 'string' },
      flagged: { type: 'boolean' },
      summary: { type: 'string' },
      analysisNotes: { type: 'string' },
    },
    required: ['issues'],
    additionalProperties: false,
  };
}

describe('OpenCodeProvider — token usage enrichment', () => {
  it('extracts reasoning, cache, and reportedCost from provider response', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          cost: 0.0789,
          tokens: { input: 500, output: 100, reasoning: 50, cache: { read: 4000, write: 200 } },
          structured: { issues: [] },
        },
        parts: [{ type: 'text', text: '{"issues":[]}' }],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.inputTokens, 500);
    assert.equal(result.tokenUsage!.outputTokens, 100);
    assert.equal(result.tokenUsage!.reasoningTokens, 50);
    assert.equal(result.tokenUsage!.cacheReadInputTokens, 4000);
    assert.equal(result.tokenUsage!.cacheCreationInputTokens, 200);
    assert.ok(result.tokenUsage!.reportedCost, 'Should have reportedCost');
    assert.equal(result.tokenUsage!.reportedCost!.amountUsd, 0.0789);
    assert.equal(result.tokenUsage!.reportedCost!.source, 'opencode');
  });

  it('omits reasoningTokens when reasoning is 0', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          structured: { issues: [] },
        },
        parts: [{ type: 'text', text: '{"issues":[]}' }],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.reasoningTokens, undefined);
    assert.equal(result.tokenUsage!.cacheReadInputTokens, undefined);
    assert.equal(result.tokenUsage!.cacheCreationInputTokens, undefined);
  });

  it('does not set reportedCost when cost is absent from info', async () => {
    const client = createMockClient({
      promptResponse: {
        info: {
          role: 'assistant',
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          structured: { issues: [] },
        },
        parts: [{ type: 'text', text: '{"issues":[]}' }],
      },
    });
    const provider = new OpenCodeProvider({ _client: client as never });
    await provider.initialize({ model: 'test-provider/test-model' });

    const result = await provider.executeCheck('test prompt', '/tmp/repo');
    assert.ok(result.tokenUsage, 'Should have tokenUsage');
    assert.equal(result.tokenUsage!.reportedCost, undefined);
  });
});
