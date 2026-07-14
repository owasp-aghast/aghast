import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDiscovery,
  registerDiscovery,
  getRegisteredDiscoveries,
  clearDiscoveryRegistry,
  unregisterDiscovery,
} from '../src/discovery.js';
import type { TargetDiscovery } from '../src/discovery.js';

/** Create a minimal stub discovery for testing. */
function stubDiscovery(name: string): TargetDiscovery {
  return {
    name,
    defaultGenericPrompt: `${name}-instructions.md`,
    needsInstructions: false,
    supportsDiffFilter: false,
    async discover() {
      return [];
    },
  };
}

describe('Discovery registry', () => {
  // Start each test with a clean registry so tests are isolated.
  beforeEach(() => {
    clearDiscoveryRegistry();
  });

  it('getDiscovery("unknown") throws with helpful error', () => {
    assert.throws(
      () => getDiscovery('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('Unknown discovery type: "unknown"'));
        assert.ok(err.message.includes('(none registered)'));
        return true;
      },
    );
  });

  it('getDiscovery("unknown") lists available discoveries in error', () => {
    registerDiscovery(stubDiscovery('alpha'));
    registerDiscovery(stubDiscovery('beta'));
    assert.throws(
      () => getDiscovery('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('alpha'));
        assert.ok(err.message.includes('beta'));
        return true;
      },
    );
  });

  it('registerDiscovery() makes discovery retrievable via getDiscovery()', () => {
    const disc = stubDiscovery('test-disc');
    registerDiscovery(disc);
    const retrieved = getDiscovery('test-disc');
    assert.equal(retrieved.name, 'test-disc');
    assert.equal(retrieved, disc);
  });

  it('getRegisteredDiscoveries() returns all registered names', () => {
    registerDiscovery(stubDiscovery('aaa'));
    registerDiscovery(stubDiscovery('bbb'));
    const names = getRegisteredDiscoveries();
    assert.deepEqual(names.sort(), ['aaa', 'bbb']);
  });

  it('getRegisteredDiscoveries() returns empty array when registry is cleared', () => {
    assert.deepEqual(getRegisteredDiscoveries(), []);
  });

  it('clearDiscoveryRegistry() removes all entries', () => {
    registerDiscovery(stubDiscovery('x'));
    assert.equal(getRegisteredDiscoveries().length, 1);
    clearDiscoveryRegistry();
    assert.equal(getRegisteredDiscoveries().length, 0);
  });

  it('unregisterDiscovery() removes a registered entry and returns true', () => {
    registerDiscovery(stubDiscovery('temp'));
    assert.equal(unregisterDiscovery('temp'), true);
    assert.deepEqual(getRegisteredDiscoveries(), []);
  });

  it('unregisterDiscovery() returns false for an unknown name', () => {
    assert.equal(unregisterDiscovery('does-not-exist'), false);
  });

  it('unregisterDiscovery() leaves other entries intact', () => {
    registerDiscovery(stubDiscovery('keep-1'));
    registerDiscovery(stubDiscovery('drop'));
    registerDiscovery(stubDiscovery('keep-2'));
    assert.equal(unregisterDiscovery('drop'), true);
    assert.deepEqual(getRegisteredDiscoveries().sort(), ['keep-1', 'keep-2']);
  });
});

describe('Built-in discoveries (loaded via scan-runner)', () => {
  // Import scan-runner to trigger the side-effect registration of built-in discoveries.
  // This must be a dynamic import so the registry is populated after clearDiscoveryRegistry()
  // in the beforeEach above doesn't interfere.
  it('semgrep, opengrep, openant, and sarif are registered after scan-runner loads', async () => {
    // Dynamic import triggers the registerDiscovery() calls in scan-runner.ts
    await import('../src/scan-runner.js');
    const names = getRegisteredDiscoveries();
    assert.ok(names.includes('semgrep'), 'semgrep should be registered');
    assert.ok(names.includes('opengrep'), 'opengrep should be registered');
    assert.ok(names.includes('openant'), 'openant should be registered');
    assert.ok(names.includes('sarif'), 'sarif should be registered');
    assert.ok(!names.includes('diff-semgrep'), 'diff-semgrep is no longer a discovery');
  });

  it('built-in discoveries declare diff-filter support correctly', async () => {
    await import('../src/scan-runner.js');
    assert.equal(getDiscovery('semgrep').supportsDiffFilter, true);
    assert.equal(getDiscovery('sarif').supportsDiffFilter, true);
    assert.equal(getDiscovery('openant').supportsDiffFilter, true);
  });
});
