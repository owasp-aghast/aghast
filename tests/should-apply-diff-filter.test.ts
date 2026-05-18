/**
 * Unit tests for the scan-runner gate that decides whether to apply the
 * diff filter to a given check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldApplyDiffFilter } from '../src/scan-runner.js';
import type { SecurityCheck } from '../src/types.js';

function check(overrides: Partial<SecurityCheck['checkTarget']> = {}): SecurityCheck {
  return {
    id: 'test',
    name: 'test',
    repositories: [],
    checkTarget: { type: 'targeted', discovery: 'semgrep', ...overrides },
  };
}

const supporting = { supportsDiffFilter: true };
const unsupporting = { supportsDiffFilter: false };

describe('shouldApplyDiffFilter', () => {
  it('false when discovery does not support diff filtering (even with a ref)', () => {
    assert.equal(shouldApplyDiffFilter(check(), unsupporting, 'main', undefined), false);
  });

  it('false when no diff source is available anywhere', () => {
    assert.equal(shouldApplyDiffFilter(check(), supporting, undefined, undefined), false);
  });

  it('true when runtime diffRef is provided', () => {
    assert.equal(shouldApplyDiffFilter(check(), supporting, 'main', undefined), true);
  });

  it('true when runtime diffFile is provided', () => {
    assert.equal(shouldApplyDiffFilter(check(), supporting, undefined, '/tmp/pr.diff'), true);
  });

  it('true when only check-level diffRef is set', () => {
    assert.equal(shouldApplyDiffFilter(check({ diffRef: 'main' }), supporting, undefined, undefined), true);
  });

  it('false when check opts out via diffFilter: false (runtime ref ignored)', () => {
    assert.equal(shouldApplyDiffFilter(check({ diffFilter: false }), supporting, 'main', undefined), false);
  });

  it('false when check opts out via diffFilter: false (check-level ref ignored)', () => {
    assert.equal(shouldApplyDiffFilter(check({ diffFilter: false, diffRef: 'main' }), supporting, undefined, undefined), false);
  });

  it('diffFilter: true is a no-op (same as default when source available)', () => {
    assert.equal(shouldApplyDiffFilter(check({ diffFilter: true }), supporting, 'main', undefined), true);
    assert.equal(shouldApplyDiffFilter(check({ diffFilter: true }), supporting, undefined, undefined), false);
  });
});
