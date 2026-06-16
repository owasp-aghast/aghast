import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, formatError, formatFatalError } from '../src/error-codes.js';

describe('error codes', () => {
  it('all error codes are unique', () => {
    const codes = Object.values(ERROR_CODES).map((ec) => ec.code);
    const unique = new Set(codes);
    assert.equal(unique.size, codes.length, `Duplicate error codes found: ${codes.filter((c, i) => codes.indexOf(c) !== i)}`);
  });

  it('all error codes follow the naming pattern', () => {
    for (const [key, ec] of Object.entries(ERROR_CODES)) {
      assert.match(ec.code, /^E\d{4}$/, `Error code ${key} has invalid format: ${ec.code}`);
      assert.equal(key, ec.code, `Key ${key} does not match code ${ec.code}`);
      assert.ok(ec.label.length > 0, `Error code ${key} has empty label`);
    }
  });

  it('formatError produces the expected pattern', () => {
    const result = formatError(ERROR_CODES.E1001, 'test message');
    assert.equal(result, 'Error [E1001]: test message');
  });

  it('formatFatalError includes version and bug report URL', () => {
    const result = formatFatalError('something broke', '1.2.3');
    assert.ok(result.includes('AGHAST Fatal Error [E9001]: something broke'));
    assert.ok(result.includes('Version: 1.2.3'));
    assert.ok(result.includes('github.com/owasp-aghast/aghast/issues/new'));
    assert.ok(result.includes('labels=bug'));
  });
});
