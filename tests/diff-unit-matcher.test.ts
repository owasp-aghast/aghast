import { describe, it } from 'node:test';
import assert from 'node:assert';
import { findTouchedUnits, filterFindingsByScope } from '../src/diff-unit-matcher.js';
import type { OpenAntUnit } from '../src/openant-loader.js';
import type { DiffMap } from '../src/diff-parser.js';
import type { CheckTarget } from '../src/types.js';

/**
 * Helper to build a minimal OpenAntUnit for testing.
 */
function makeUnit(overrides: {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  functionName: string;
  directCalls?: string[];
  directCallers?: string[];
  filesIncluded?: string[];
}): OpenAntUnit {
  return {
    id: overrides.id,
    unit_type: 'function',
    code: {
      primary_code: '',
      primary_origin: {
        file_path: overrides.file,
        start_line: overrides.startLine,
        end_line: overrides.endLine,
        function_name: overrides.functionName,
        class_name: null,
        enhanced: false,
        files_included: overrides.filesIncluded ?? [],
        original_length: 0,
        enhanced_length: 0,
      },
      dependencies: [],
      dependency_metadata: {
        depth: 0, total_upstream: 0, total_downstream: 0,
        direct_calls: 0, direct_callers: 0,
      },
    },
    ground_truth: { status: 'unknown' },
    metadata: {
      decorators: [],
      is_async: false,
      parameters: [],
      docstring: null,
      direct_calls: overrides.directCalls ?? [],
      direct_callers: overrides.directCallers ?? [],
    },
    reachable: true,
    is_entry_point: false,
    entry_point_reason: '',
  };
}

function makeFinding(file: string, startLine: number, endLine: number, message?: string): CheckTarget {
  return { file, startLine, endLine, message: message ?? 'test finding' };
}

describe('diff-unit-matcher', () => {
  describe('findTouchedUnits', () => {
    it('should find directly overlapping units (Tier 1)', () => {
      const units = [
        makeUnit({ id: 'a', file: 'src/auth.js', startLine: 1, endLine: 20, functionName: 'authenticate' }),
        makeUnit({ id: 'b', file: 'src/auth.js', startLine: 25, endLine: 40, functionName: 'logout' }),
        makeUnit({ id: 'c', file: 'src/other.js', startLine: 1, endLine: 50, functionName: 'unrelated' }),
      ];

      const diffMap: DiffMap = new Map([
        ['src/auth.js', [{ file: 'src/auth.js', startLine: 10, endLine: 15 }]],
      ]);

      const touched = findTouchedUnits(units, diffMap, 0); // depth 0 = direct only
      assert.equal(touched.length, 1);
      assert.equal(touched[0].id, 'a');
    });

    it('should find call graph neighbours (Tier 2, depth=1)', () => {
      const units = [
        makeUnit({ id: 'a', file: 'src/auth.js', startLine: 1, endLine: 20, functionName: 'authenticate', directCalls: ['validate'] }),
        makeUnit({ id: 'b', file: 'src/validate.js', startLine: 1, endLine: 30, functionName: 'validate', directCallers: ['authenticate'] }),
        makeUnit({ id: 'c', file: 'src/other.js', startLine: 1, endLine: 50, functionName: 'unrelated' }),
      ];

      const diffMap: DiffMap = new Map([
        ['src/auth.js', [{ file: 'src/auth.js', startLine: 5, endLine: 10 }]],
      ]);

      const touched = findTouchedUnits(units, diffMap, 1);
      assert.equal(touched.length, 2);
      const ids = touched.map(u => u.id).sort();
      assert.deepStrictEqual(ids, ['a', 'b']);
    });

    it('should respect depth=0 (no call graph traversal)', () => {
      const units = [
        makeUnit({ id: 'a', file: 'src/auth.js', startLine: 1, endLine: 20, functionName: 'authenticate', directCalls: ['validate'] }),
        makeUnit({ id: 'b', file: 'src/validate.js', startLine: 1, endLine: 30, functionName: 'validate', directCallers: ['authenticate'] }),
      ];

      const diffMap: DiffMap = new Map([
        ['src/auth.js', [{ file: 'src/auth.js', startLine: 5, endLine: 10 }]],
      ]);

      const touched = findTouchedUnits(units, diffMap, 0);
      assert.equal(touched.length, 1);
      assert.equal(touched[0].id, 'a');
    });

    it('should follow transitive call graph at depth=2', () => {
      const units = [
        makeUnit({ id: 'a', file: 'src/a.js', startLine: 1, endLine: 10, functionName: 'funcA', directCalls: ['funcB'] }),
        makeUnit({ id: 'b', file: 'src/b.js', startLine: 1, endLine: 10, functionName: 'funcB', directCallers: ['funcA'], directCalls: ['funcC'] }),
        makeUnit({ id: 'c', file: 'src/c.js', startLine: 1, endLine: 10, functionName: 'funcC', directCallers: ['funcB'] }),
      ];

      const diffMap: DiffMap = new Map([
        ['src/a.js', [{ file: 'src/a.js', startLine: 1, endLine: 5 }]],
      ]);

      // depth=1: A is direct, B is 1-hop → C is NOT included
      const touched1 = findTouchedUnits(units, diffMap, 1);
      assert.equal(touched1.length, 2);

      // depth=2: A is direct, B is 1-hop, C is 2-hop → all included
      const touched2 = findTouchedUnits(units, diffMap, 2);
      assert.equal(touched2.length, 3);
    });

    it('should handle callers touching callees', () => {
      // If unit B calls unit A, and A is touched, B should be included (B is a caller)
      const units = [
        makeUnit({ id: 'a', file: 'src/a.js', startLine: 1, endLine: 10, functionName: 'funcA', directCallers: ['funcB'] }),
        makeUnit({ id: 'b', file: 'src/b.js', startLine: 1, endLine: 10, functionName: 'funcB', directCalls: ['funcA'] }),
      ];

      const diffMap: DiffMap = new Map([
        ['src/a.js', [{ file: 'src/a.js', startLine: 1, endLine: 5 }]],
      ]);

      const touched = findTouchedUnits(units, diffMap, 1);
      assert.equal(touched.length, 2);
    });

    it('should handle empty diff', () => {
      const units = [
        makeUnit({ id: 'a', file: 'src/a.js', startLine: 1, endLine: 10, functionName: 'funcA' }),
      ];

      const diffMap: DiffMap = new Map();
      const touched = findTouchedUnits(units, diffMap, 1);
      assert.equal(touched.length, 0);
    });

    it('should not match units via files_included (too broad for diff scoping)', () => {
      const units = [
        makeUnit({
          id: 'a', file: 'src/a.js', startLine: 1, endLine: 10,
          functionName: 'funcA', filesIncluded: ['src/a.js', 'src/helper.js'],
        }),
      ];

      // Diff touches helper.js which is in files_included but not in the unit's own file
      const diffMap: DiffMap = new Map([
        ['src/helper.js', [{ file: 'src/helper.js', startLine: 1, endLine: 5 }]],
      ]);

      const touched = findTouchedUnits(units, diffMap, 0);
      assert.equal(touched.length, 0, 'files_included should not cause a match');
    });

    it('should not duplicate units', () => {
      // Unit is both directly touched AND a call graph neighbour
      const units = [
        makeUnit({ id: 'a', file: 'src/a.js', startLine: 1, endLine: 10, functionName: 'funcA', directCalls: ['funcB'] }),
        makeUnit({ id: 'b', file: 'src/b.js', startLine: 1, endLine: 10, functionName: 'funcB', directCallers: ['funcA'] }),
      ];

      const diffMap: DiffMap = new Map([
        ['src/a.js', [{ file: 'src/a.js', startLine: 1, endLine: 5 }]],
        ['src/b.js', [{ file: 'src/b.js', startLine: 1, endLine: 5 }]],
      ]);

      const touched = findTouchedUnits(units, diffMap, 1);
      assert.equal(touched.length, 2);
    });
  });

  describe('filterFindingsByScope', () => {
    const allUnits = [
      makeUnit({ id: 'a', file: 'src/auth.js', startLine: 1, endLine: 20, functionName: 'authenticate' }),
      makeUnit({ id: 'b', file: 'src/auth.js', startLine: 25, endLine: 40, functionName: 'logout' }),
      makeUnit({ id: 'c', file: 'src/orders.js', startLine: 1, endLine: 50, functionName: 'getOrder' }),
    ];

    it('should include findings in touched units (Path A)', () => {
      const touchedUnits = [allUnits[0]]; // only authenticate (1-20)
      const findings = [
        makeFinding('src/auth.js', 10, 15), // inside authenticate → included
        makeFinding('src/auth.js', 30, 35), // inside logout → not included (not touched)
        makeFinding('src/orders.js', 5, 10), // inside getOrder → not included (not touched)
      ];

      const diffMap: DiffMap = new Map(); // not relevant for Path A

      const filtered = filterFindingsByScope(findings, touchedUnits, allUnits, diffMap);
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].startLine, 10);
    });

    it('should include findings in uncovered files with diff changes (Path B)', () => {
      const touchedUnits: OpenAntUnit[] = [];
      const findings = [
        makeFinding('config/settings.yaml', 1, 3), // no OpenAnt coverage, but has diff
        makeFinding('config/other.yaml', 1, 3),     // no OpenAnt coverage, no diff
      ];

      const diffMap: DiffMap = new Map([
        ['config/settings.yaml', [{ file: 'config/settings.yaml', startLine: 1, endLine: 5 }]],
      ]);

      const filtered = filterFindingsByScope(findings, touchedUnits, allUnits, diffMap);
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].file, 'config/settings.yaml');
    });

    it('should exclude findings in covered files outside touched units', () => {
      const touchedUnits = [allUnits[0]]; // only authenticate
      const findings = [
        makeFinding('src/auth.js', 30, 35), // inside logout, which is covered but not touched
      ];

      const diffMap: DiffMap = new Map();

      const filtered = filterFindingsByScope(findings, touchedUnits, allUnits, diffMap);
      assert.equal(filtered.length, 0);
    });

    it('should exclude findings in uncovered files without diff changes', () => {
      const touchedUnits: OpenAntUnit[] = [];
      const findings = [
        makeFinding('config/no-diff.yaml', 1, 3),
      ];

      const diffMap: DiffMap = new Map();

      const filtered = filterFindingsByScope(findings, touchedUnits, allUnits, diffMap);
      assert.equal(filtered.length, 0);
    });

    it('should handle empty findings', () => {
      const diffMap: DiffMap = new Map();
      const filtered = filterFindingsByScope([], [], allUnits, diffMap);
      assert.equal(filtered.length, 0);
    });

    it('should handle mixed Path A and Path B findings', () => {
      const touchedUnits = [allUnits[0]]; // authenticate (1-20) in src/auth.js
      const findings = [
        makeFinding('src/auth.js', 10, 15),          // Path A: in touched unit → included
        makeFinding('src/auth.js', 30, 35),           // Path A: in covered but not touched → excluded
        makeFinding('config/settings.yaml', 1, 3),    // Path B: uncovered, has diff → included
        makeFinding('config/no-diff.yaml', 1, 3),     // Path B: uncovered, no diff → excluded
      ];

      const diffMap: DiffMap = new Map([
        ['config/settings.yaml', [{ file: 'config/settings.yaml', startLine: 1, endLine: 5 }]],
      ]);

      const filtered = filterFindingsByScope(findings, touchedUnits, allUnits, diffMap);
      assert.equal(filtered.length, 2);
      assert.equal(filtered[0].file, 'src/auth.js');
      assert.equal(filtered[1].file, 'config/settings.yaml');
    });
  });
});
