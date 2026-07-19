import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFormatter, getAvailableFormats } from '../src/formatters/index.js';

describe('Formatter registry', () => {
  it('getFormatter("json") returns a formatter with id "json"', () => {
    const f = getFormatter('json');
    assert.equal(f.id, 'json');
  });

  it('getFormatter("sarif") returns a formatter with id "sarif"', () => {
    const f = getFormatter('sarif');
    assert.equal(f.id, 'sarif');
  });

  it('getFormatter("csv") returns a formatter with id "csv"', () => {
    const f = getFormatter('csv');
    assert.equal(f.id, 'csv');
  });

  it('getFormatter("markdown") returns a formatter with id "markdown"', () => {
    const f = getFormatter('markdown');
    assert.equal(f.id, 'markdown');
    assert.equal(f.fileExtension, '.md');
  });

  it('getFormatter("html") returns a formatter with id "html"', () => {
    const f = getFormatter('html');
    assert.equal(f.id, 'html');
  });

  it('getFormatter("unknown") throws with descriptive error', () => {
    assert.throws(
      () => getFormatter('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('Unknown output format "unknown"'));
        assert.ok(err.message.includes('json'));
        assert.ok(err.message.includes('sarif'));
        assert.ok(err.message.includes('csv'));
        assert.ok(err.message.includes('html'));
        assert.ok(err.message.includes('markdown'));
        return true;
      },
    );
  });

  it('getAvailableFormats() returns all five formats', () => {
    const formats = getAvailableFormats();
    assert.ok(formats.includes('json'));
    assert.ok(formats.includes('sarif'));
    assert.ok(formats.includes('csv'));
    assert.ok(formats.includes('html'));
    assert.ok(formats.includes('markdown'));
    assert.equal(formats.length, 5);
  });
});
