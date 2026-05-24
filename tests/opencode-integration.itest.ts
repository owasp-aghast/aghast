/**
 * Real OpenCode integration tests.
 * These tests actually invoke the OpenCode SDK and send prompts to a real LLM.
 * Uses opencode/nemotron-3-super-free (free, no API key needed).
 * This model might need to be updated every so often...
 * Requires opencode CLI to be installed (npm install -g opencode-ai).
 * Skip explicitly by setting AGHAST_SKIP_OPENCODE_TESTS=true.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeProvider } from '../src/opencode-provider.js';
import { FatalProviderError } from '../src/types.js';

const skip = !!process.env.AGHAST_SKIP_OPENCODE_TESTS;

if (skip) {
  console.log('Skipping OpenCode integration tests (AGHAST_SKIP_OPENCODE_TESTS set)');
}

describe('OpenCode integration tests', { skip }, () => {
  // Track providers for cleanup
  const providers: OpenCodeProvider[] = [];

  after(async () => {
    for (const p of providers) {
      await p.cleanup();
    }
  });

  it('initializes with opencode/nemotron-3-super-free and validates model', async () => {
    const provider = new OpenCodeProvider();
    providers.push(provider);
    await provider.initialize({ model: 'opencode/nemotron-3-super-free' });
    assert.equal(provider.getModelName(), 'opencode/nemotron-3-super-free');
    const valid = await provider.validateConfig();
    assert.equal(valid, true);
  });

  it('rejects an invalid model with FatalProviderError listing available models', async () => {
    const provider = new OpenCodeProvider();
    providers.push(provider);
    await assert.rejects(
      () => provider.initialize({ model: 'opencode/nonexistent-model-xyz' }),
      (err: unknown) => {
        assert.ok(err instanceof FatalProviderError);
        assert.ok(err.message.includes('nonexistent-model-xyz'), 'Should mention the invalid model');
        assert.ok(err.message.includes('opencode/'), 'Should list available models');
        return true;
      },
    );
  });

  it('executeCheck sends a prompt and gets a parsed response', async () => {
    const provider = new OpenCodeProvider();
    providers.push(provider);
    await provider.initialize({ model: 'opencode/nemotron-3-super-free' });

    // Simple prompt that should return empty issues
    const result = await provider.executeCheck(
      'Return exactly this JSON and nothing else: {"issues": []}',
      process.cwd(),
    );

    assert.ok(result.raw !== undefined, 'Should have raw response');
    // The model should return parseable JSON (either via structured output or text fallback)
    assert.ok(result.parsed, 'Should have parsed response');
    assert.ok(Array.isArray(result.parsed.issues), 'Parsed response should have issues array');
  });

  it('executeCheck returns issues when prompted to find them', async () => {
    const provider = new OpenCodeProvider();
    providers.push(provider);
    await provider.initialize({ model: 'opencode/nemotron-3-super-free' });

    const result = await provider.executeCheck(
      'Return exactly this JSON and nothing else: {"issues": [{"file": "test.js", "startLine": 1, "endLine": 2, "description": "Test issue"}]}',
      process.cwd(),
    );

    assert.ok(result.parsed, 'Should have parsed response');
    assert.equal(result.parsed.issues.length, 1, 'Should have 1 issue');
    assert.equal(result.parsed.issues[0].file, 'test.js');
    assert.equal(result.parsed.issues[0].startLine, 1);
    assert.equal(result.parsed.issues[0].description, 'Test issue');
  });

  it('cleanup stops the server without error', async () => {
    const provider = new OpenCodeProvider();
    // Don't push to providers array — we clean up manually here
    await provider.initialize({ model: 'opencode/nemotron-3-super-free' });
    await provider.cleanup();
    // Second cleanup should be idempotent
    await provider.cleanup();
    const valid = await provider.validateConfig();
    assert.equal(valid, false, 'Should be invalid after cleanup');
  });
});
