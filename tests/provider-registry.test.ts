/**
 * Unit tests for the provider registry and AgentProvider interface compliance.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  registerProvider,
  createProviderByName,
  getProviderNames,
  DEFAULT_PROVIDER_NAME,
} from '../src/provider-registry.js';
import { ClaudeCodeProvider } from '../src/claude-code-provider.js';
import { OpenCodeProvider } from '../src/opencode-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper to dynamically import MockAgentProvider (avoids tsc emitting stray .js files)
async function getMockProvider() {
  const mockModulePath = pathToFileURL(resolve(__dirname, 'mocks', 'mock-agent-provider.js')).href;
  const { MockAgentProvider } = await import(mockModulePath);
  return MockAgentProvider;
}

// ─── Provider registry ────────────────────────────────────────────────────────

describe('Provider registry', () => {
  it('getProviderNames() includes claude-code and opencode', () => {
    const names = getProviderNames();
    assert.ok(names.includes('claude-code'), `Expected 'claude-code' in ${JSON.stringify(names)}`);
    assert.ok(names.includes('opencode'), `Expected 'opencode' in ${JSON.stringify(names)}`);
  });

  it('createProviderByName(\'claude-code\') returns an object with all AgentProvider methods', () => {
    const provider = createProviderByName('claude-code');
    assert.equal(typeof provider.initialize, 'function');
    assert.equal(typeof provider.executeCheck, 'function');
    assert.equal(typeof provider.validateConfig, 'function');
  });

  it('createProviderByName(\'unknown-xyz\') throws with message listing known providers', () => {
    assert.throws(
      () => createProviderByName('unknown-xyz'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Unknown agent provider'), `message: ${err.message}`);
        assert.ok(err.message.includes('claude-code'), `should list claude-code: ${err.message}`);
        return true;
      },
    );
  });

  it('registerProvider adds a new provider that can be created by name', () => {
    // The registry is a module-level singleton. Cross-test contamination is avoided
    // because the Node.js test runner executes each test file in an isolated process,
    // and within this file unique names are used to prevent collisions.
    const testName = 'test-custom-registry-8a3f';
    registerProvider(testName, () => new ClaudeCodeProvider());
    const names = getProviderNames();
    assert.ok(names.includes(testName), `Expected '${testName}' in ${JSON.stringify(names)}`);
  });

  it('registered custom provider can be created and initialized', async () => {
    const testName = 'test-custom-init-9b2e';
    let factoryCalled = false;
    registerProvider(testName, () => {
      factoryCalled = true;
      return new ClaudeCodeProvider();
    });

    const provider = createProviderByName(testName);
    assert.ok(factoryCalled, 'Factory should have been called');
    assert.equal(typeof provider.initialize, 'function');
    assert.equal(typeof provider.executeCheck, 'function');
    assert.equal(typeof provider.validateConfig, 'function');
  });

  it('DEFAULT_PROVIDER_NAME is \'claude-code\'', () => {
    assert.equal(DEFAULT_PROVIDER_NAME, 'claude-code');
  });

  it('error from createProviderByName lists all registered providers', () => {
    const knownNames = getProviderNames();
    assert.throws(
      () => createProviderByName('does-not-exist-7c4d'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const name of knownNames) {
          assert.ok(err.message.includes(name), `Error should list provider "${name}": ${err.message}`);
        }
        return true;
      },
    );
  });
});

// ─── AgentProvider interface compliance — ClaudeCodeProvider ─────────────────────

describe('AgentProvider interface compliance — ClaudeCodeProvider', () => {
  it('has initialize method', () => {
    const provider = new ClaudeCodeProvider();
    assert.equal(typeof provider.initialize, 'function');
  });

  it('has executeCheck method', () => {
    const provider = new ClaudeCodeProvider();
    assert.equal(typeof provider.executeCheck, 'function');
  });

  it('has validateConfig method', () => {
    const provider = new ClaudeCodeProvider();
    assert.equal(typeof provider.validateConfig, 'function');
  });

  it('has getModelName method', () => {
    const provider = new ClaudeCodeProvider();
    assert.equal(typeof provider.getModelName, 'function');
  });

  it('validateConfig() returns false before initialize (no key or local Claude set)', async () => {
    // Test the default state: apiKey=undefined, useLocalClaude=false
    // Note: initialize() would throw, so we test validateConfig on a fresh instance
    const originalLocalClaude = process.env.AGHAST_LOCAL_CLAUDE;
    delete process.env.AGHAST_LOCAL_CLAUDE;
    try {
      const provider = new ClaudeCodeProvider();
      const result = await provider.validateConfig();
      assert.equal(result, false, 'validateConfig should return false with no key and no local Claude');
    } finally {
      if (originalLocalClaude !== undefined) {
        process.env.AGHAST_LOCAL_CLAUDE = originalLocalClaude;
      }
    }
  });

  it('validateConfig() returns true after initialize with API key', async () => {
    const provider = new ClaudeCodeProvider();
    await provider.initialize({ apiKey: 'test-api-key-12345' });
    const result = await provider.validateConfig();
    assert.equal(result, true);
  });

  it('initialize() stores model correctly (getModelName returns configured model)', async () => {
    const provider = new ClaudeCodeProvider();
    await provider.initialize({ apiKey: 'test-key', model: 'claude-opus-4-6' });
    assert.equal(provider.getModelName(), 'claude-opus-4-6');
  });

  it('initialize() throws when no API key and no local Claude', async () => {
    const originalLocalClaude = process.env.AGHAST_LOCAL_CLAUDE;
    delete process.env.AGHAST_LOCAL_CLAUDE;
    try {
      // Inject a "not logged in" detector so the test never spawns the real agent SDK.
      const provider = new ClaudeCodeProvider({ _detectLocalLogin: async () => false });
      await assert.rejects(
        async () => provider.initialize({}),
        /ANTHROPIC_API_KEY/,
      );
    } finally {
      if (originalLocalClaude !== undefined) {
        process.env.AGHAST_LOCAL_CLAUDE = originalLocalClaude;
      }
    }
  });
});

// ─── AgentProvider interface compliance — OpenCodeProvider ──────────────────────

describe('AgentProvider interface compliance — OpenCodeProvider', () => {
  it('has all required AgentProvider methods', () => {
    const provider = new OpenCodeProvider();
    assert.equal(typeof provider.initialize, 'function');
    assert.equal(typeof provider.executeCheck, 'function');
    assert.equal(typeof provider.validateConfig, 'function');
  });

  it('has optional AgentProvider methods', () => {
    const provider = new OpenCodeProvider();
    assert.equal(typeof provider.getModelName, 'function');
    assert.equal(typeof provider.setModel, 'function');
    assert.equal(typeof provider.checkPrerequisites, 'function');
    assert.equal(typeof provider.cleanup, 'function');
  });

  it('createProviderByName(\'opencode\') returns an OpenCodeProvider', () => {
    const provider = createProviderByName('opencode');
    assert.ok(provider instanceof OpenCodeProvider);
  });
});

// ─── AgentProvider interface compliance — MockAgentProvider ─────────────────────────

describe('AgentProvider interface compliance — MockAgentProvider', () => {
  it('has initialize method', async () => {
    const MockAgentProvider = await getMockProvider();
    const provider = new MockAgentProvider();
    assert.equal(typeof provider.initialize, 'function');
  });

  it('has executeCheck method', async () => {
    const MockAgentProvider = await getMockProvider();
    const provider = new MockAgentProvider();
    assert.equal(typeof provider.executeCheck, 'function');
  });

  it('has validateConfig method', async () => {
    const MockAgentProvider = await getMockProvider();
    const provider = new MockAgentProvider();
    assert.equal(typeof provider.validateConfig, 'function');
  });

  it('validateConfig() returns true by default', async () => {
    const MockAgentProvider = await getMockProvider();
    const provider = new MockAgentProvider();
    const result = await provider.validateConfig();
    assert.equal(result, true);
  });

  it('validateConfig() returns false when configured with validConfig: false', async () => {
    const MockAgentProvider = await getMockProvider();
    const provider = new MockAgentProvider({ validConfig: false });
    const result = await provider.validateConfig();
    assert.equal(result, false);
  });

  it('initialize() sets initialized flag', async () => {
    const MockAgentProvider = await getMockProvider();
    const provider = new MockAgentProvider();
    assert.equal(provider.initialized, false);
    await provider.initialize({});
    assert.equal(provider.initialized, true);
  });

  it('executeCheck() returns default empty issues response', async () => {
    const MockAgentProvider = await getMockProvider();
    const provider = new MockAgentProvider();
    await provider.initialize({});
    const response = await provider.executeCheck('test prompt', '/tmp');
    assert.ok(response.parsed, 'Should have parsed response');
    assert.deepEqual(response.parsed.issues, []);
  });
});
