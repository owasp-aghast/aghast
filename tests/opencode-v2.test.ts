/** Focused integration coverage using the published v2 client and a local HTTP transport. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { OpenCode } from '@opencode-ai/client';
import { OpenCodeProvider } from '../src/opencode-provider.js';
import { FatalProviderError } from '../src/types.js';
import { addHandler, removeHandler, type LogEntry, type LogHandler } from '../src/logging.js';

const tokens = { input: 120, output: 30, reasoning: 4, cache: { read: 10, write: 2 } };
const directory = 'C:/repo with spaces';

function fixture(options: { failure?: boolean; interrupted?: boolean; apiError?: boolean; empty?: boolean; activating?: boolean;
  shellRequest?: boolean; permissionError?: boolean; rejectionError?: boolean; sseError?: boolean; savedActions?: string[] } = {}) {
  const calls: Array<{ path: string; query: URLSearchParams; body?: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let counter = 0;
  let activationChecks = 0;
  const permissionWaiters = new Map<string, () => void>();
  const json = (data: unknown) => Response.json(data);
  function emit(type: string, data: Record<string, unknown>) {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ type, data })}\n\n`);
    for (const stream of streams) stream.enqueue(frame);
  }
  const transport: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, query: parsed.searchParams, body, signal: init?.signal });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Basic test-auth');
    if (path === '/api/plugin') return json({ data: options.activating && activationChecks++ === 0
      ? [] : [{ id: 'opencode.config.policy', state: { status: 'active' } }] });
    if (path === '/api/provider') return json({ data: [{ id: 'test', name: 'Test Provider' }] });
    if (path === '/api/model') return json({ data: [
      { id: 'model', modelID: 'upstream-model', providerID: 'test', name: 'Test Model', enabled: true },
      { id: 'disabled', modelID: 'disabled', providerID: 'test', name: 'Disabled', enabled: false },
    ] });
    if (path === '/api/event') {
      if (options.sseError) throw new Error('progress stream unavailable');
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streams.add(controller);
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'));
          init?.signal?.addEventListener('abort', () => { streams.delete(controller); controller.close(); }, { once: true });
        },
        cancel() { streams.clear(); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/api/permission/saved') return json({ data: (options.savedActions ?? []).map(action => ({ action })) });
    if (path === '/api/session') return json({ data: { id: `ses-${++counter}`, projectID: `project-${counter}` } });
    const sessionID = path.split('/')[3];
    if (path.endsWith('/interrupt')) return new Response(null, { status: 204 });
    if (path.endsWith('/permission')) {
      if (options.permissionError) return Response.json({ _tag: 'ServiceUnavailableError', message: 'permission transport failed' }, { status: 503 });
      return json({ data: permissionWaiters.has(sessionID) ? [
        { id: `shell-${sessionID}`, sessionID, action: 'shell', resources: ['echo synthetic'] },
        { id: 'other-session', sessionID: 'not-owned', action: 'shell', resources: ['echo unrelated'] },
      ] : [] });
    }
    if (path.includes('/permission/') && path.endsWith('/reply')) {
      if (options.rejectionError) return Response.json({ _tag: 'ServiceUnavailableError', message: 'permission rejection failed' }, { status: 503 });
      assert.equal(body?.decision, 'reject');
      permissionWaiters.get(sessionID)?.();
      permissionWaiters.delete(sessionID);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/model')) return new Response(null, { status: 204 });
    if (path.endsWith('/prompt')) {
      if (options.apiError) return Response.json({ _tag: 'BadRequestError', message: 'invalid prompt' }, { status: 400 });
      return json({ data: { id: 'queued', sessionID, type: 'user' } });
    }
    if (path.endsWith('/wait')) {
      const id = path.split('/')[4];
      emit('session.execution.failed', { sessionID: 'another-session', error: { type: 'APIError', message: 'ignore this' } });
      emit('session.step.failed', { sessionID: id, error: { type: 'APIError', message: 'retryable step failure' } });
      emit('session.tool.input.started', { sessionID: id, id: 'tool-1', name: 'read' });
      emit('session.tool.called', { sessionID: id, id: 'tool-1', input: { filePath: 'test.ts' } });
      emit('session.tool.success', { sessionID: id, id: 'tool-1', content: [{ type: 'text', text: 'file contents' }] });
      if (options.failure) {
        emit('session.execution.failed', { sessionID: id, error: { type: 'APIError', message: 'Streaming response failed' } });
        await new Promise<void>(resolve => {
          if (init?.signal?.aborted) resolve();
          else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('request aborted');
      }
      if (options.shellRequest) await new Promise<void>(resolve => {
        permissionWaiters.set(id, resolve);
        init?.signal?.addEventListener('abort', () => { permissionWaiters.delete(id); resolve(); }, { once: true });
      });
      // Deliver queued SSE frames before the completion response, as the real
      // server does when it finishes an execution.
      await setImmediate();
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/message')) return json({ data: options.empty ? [] : [{
      type: 'assistant', id: 'answer', tokens: { ...tokens, input: 1 },
      content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '{"issues":[]}' }],
    }] });
    if (/^\/api\/session\/ses-\d+$/.test(path)) return json({ data: {
      id: sessionID, tokens, cost: 0.012, outcome: options.interrupted ? 'interrupted' : 'succeeded',
    } });
    throw new Error(`Unexpected request ${path}`);
  };
  const client = OpenCode.make({ baseUrl: 'http://local.test', headers: { Authorization: 'Basic test-auth' }, fetch: transport });
  return { provider: new OpenCodeProvider({ _v2Client: client }), calls, streams };
}

describe('OpenCode 2 client integration', { skip: !('withResolvers' in Promise) }, () => {
  it('waits for plugin activation before reading the provider/model catalogs', async () => {
    const { provider, calls } = fixture({ activating: true });
    try {
      await provider.initialize({ model: 'test/model' });
      assert.deepEqual(calls.slice(0, 4).map(call => call.path), [
        '/api/plugin', '/api/plugin', '/api/provider', '/api/model',
      ]);
      assert.ok(calls[0].signal);
    } finally {
      await provider.cleanup();
    }
  });
  it('maps discovery, permissions, model selection and queued prompts to the provider contract', async () => {
    const { provider, calls, streams } = fixture();
    const logs: LogEntry[] = [];
    const handler: LogHandler = { level: 'debug', handle(entry) { logs.push(entry); } };
    addHandler(handler);
    try {
      await provider.initialize({ model: 'test/model' });
      assert.deepEqual(await provider.listModels(), [{ id: 'test/model', label: 'Test Model', description: 'Test Provider' }]);
      const result = await provider.executeCheck('Find issues', directory);
      assert.deepEqual(result.parsed, { issues: [] });
      assert.equal(result.raw, '{"issues":[]}');
      assert.deepEqual(result.tokenUsage, {
        inputTokens: 120, outputTokens: 30, reasoningTokens: 4,
        cacheReadInputTokens: 10, cacheCreationInputTokens: 2, totalTokens: 150,
        reportedCost: { amountUsd: 0.012, source: 'opencode' },
      });
      assert.deepEqual(calls.find(call => call.path === '/api/session')?.body, {
        title: 'aghast security check', location: { directory },
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          ...['read', 'glob', 'grep', 'list'].map(action => ({ action, resource: '*', effect: 'allow' })),
          { action: 'shell', resource: '*', effect: 'ask' },
        ],
      });
      assert.deepEqual(calls.find(call => call.path === '/api/session/ses-1/model')?.body, { model: { id: 'model', providerID: 'test' } });
      const prompt = calls.find(call => call.path.endsWith('/prompt'))!;
      assert.match(String(prompt.body?.text), /^Find issues\n\nReturn only JSON matching this schema:/);
      assert.deepEqual(Object.keys(prompt.body!), ['text']);
      assert.ok(calls.find(call => call.path.endsWith('/wait'))?.signal);
      const messages = calls.find(call => call.path.endsWith('/message'))!;
      assert.equal(messages.query.get('order'), 'desc');
      assert.equal(messages.query.get('type'), 'assistant');
      assert.equal(messages.query.get('limit'), '1');
      assert.ok(logs.some(entry => entry.message.includes('Tool[1]: read')));
      assert.ok(logs.some(entry => entry.message.includes('Tool done: read')));
      assert.equal(streams.size, 0, 'SSE connection closes on completion');
    } finally {
      removeHandler(handler);
      await provider.cleanup();
    }
  });

  it('automatically rejects approval-gated shell requests only for the owned session', async () => {
    const { provider, calls } = fixture({ shellRequest: true });
    await provider.initialize({ model: 'test/model' });
    const result = await provider.executeCheck('Find issues', directory);
    assert.deepEqual(result.parsed, { issues: [] });
    const replies = calls.filter(call => call.path.endsWith('/reply'));
    assert.equal(replies.length, 1);
    assert.match(replies[0].path, /\/ses-1\/permission\/shell-ses-1\/reply$/);
    assert.equal(replies[0].body?.decision, 'reject');
    assert.match(String(replies[0].body?.message), /Shell commands are prohibited/);
    const saved = calls.find(call => call.path === '/api/permission/saved')!;
    assert.equal(saved.query.get('projectID'), 'project-1');
    assert.ok(calls.filter(call => call.path.endsWith('/permission') || call.path.endsWith('/reply')).every(call => call.signal?.aborted));
  });

  it('fails closed and interrupts the session when permission monitoring fails', async () => {
    const { provider, calls } = fixture({ permissionError: true });
    await provider.initialize({ model: 'test/model' });
    await assert.rejects(() => provider.executeCheck('Find issues', directory), /Cannot enforce read-only OpenCode shell permissions/);
    assert.ok(calls.some(call => call.path.endsWith('/interrupt')));
  });

  it('rejects shell requests even when the optional progress event stream is unavailable', async () => {
    const { provider, calls } = fixture({ shellRequest: true, sseError: true, savedActions: ['read'] });
    await provider.initialize({ model: 'test/model' });
    assert.deepEqual((await provider.executeCheck('Find issues', directory)).parsed, { issues: [] });
    assert.equal(calls.filter(call => call.path.endsWith('/reply')).length, 1);
  });

  it('fails closed when rejecting a shell request fails', async () => {
    const { provider, calls } = fixture({ shellRequest: true, rejectionError: true });
    await provider.initialize({ model: 'test/model' });
    await assert.rejects(() => provider.executeCheck('Find issues', directory), /Cannot enforce read-only OpenCode shell permissions/);
    assert.ok(calls.some(call => call.path.endsWith('/interrupt')));
  });

  it('refuses saved shell approvals, including wildcard actions, before submitting a prompt', async () => {
    for (const action of ['shell', '*', 'sh?ll', 's*']) {
      const { provider, calls } = fixture({ savedActions: [action] });
      await provider.initialize({ model: 'test/model' });
      await assert.rejects(() => provider.executeCheck('Find issues', directory), /saved shell approvals exist/);
      assert.ok(!calls.some(call => call.path.endsWith('/prompt')));
      assert.ok(!calls.some(call => call.path.includes('/saved/') && call.body), 'User approvals are never removed');
    }
  });

  it('rejects unavailable models using v2 model discovery', async () => {
    const { provider } = fixture();
    await assert.rejects(() => provider.initialize({ model: 'test/disabled' }), FatalProviderError);
  });

  it('aborts the completion wait on a v2 execution error without returning partial findings', async () => {
    const { provider, streams } = fixture({ failure: true });
    await provider.initialize({ model: 'test/model' });
    await assert.rejects(() => provider.executeCheck('Find issues', directory), /OpenCode session failed: Streaming response failed/);
    assert.equal(streams.size, 0);
  });

  it('rejects interrupted sessions even when the event stream missed the interruption', async () => {
    const { provider } = fixture({ interrupted: true });
    await provider.initialize({ model: 'test/model' });
    await assert.rejects(() => provider.executeCheck('Find issues', directory), /session interrupted/);
  });

  it('propagates HTTP failures from the v2 client and closes the event stream', async () => {
    const { provider, streams } = fixture({ apiError: true });
    await provider.initialize({ model: 'test/model' });
    await assert.rejects(() => provider.executeCheck('Find issues', directory), /invalid prompt/);
    assert.equal(streams.size, 0);
  });

  it('fails when a completed session has no assistant text', async () => {
    const { provider } = fixture({ empty: true });
    await provider.initialize({ model: 'test/model' });
    await assert.rejects(() => provider.executeCheck('Find issues', directory), /no text response/);
  });

  it('keeps concurrent sessions isolated while sharing the v2 event transport', async () => {
    const { provider, calls, streams } = fixture({ shellRequest: true });
    await provider.initialize({ model: 'test/model' });
    const results = await Promise.all([
      provider.executeCheck('Check A', directory),
      provider.executeCheck('Check B', 'C:/another repo'),
    ]);
    assert.ok(results.every(result => result.parsed?.issues.length === 0));
    assert.equal(calls.filter(call => call.path === '/api/session').length, 2);
    assert.equal(calls.filter(call => call.path.endsWith('/wait')).length, 2);
    assert.equal(calls.filter(call => call.path.endsWith('/reply')).length, 2);
    assert.equal(calls.filter(call => call.path === '/api/event').length, 1);
    assert.equal(streams.size, 0);
  });
});
