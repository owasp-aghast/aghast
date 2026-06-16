/**
 * Property-based fuzz tests using fast-check.
 *
 * Tests 20 functions across 4 tiers for robustness, security invariants,
 * and algebraic properties. Satisfies the OpenSSF Scorecard Fuzzing check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { resolve, sep, join } from 'node:path';

import { parseAgentResponse } from '../src/response-parser.js';
import { parseSARIF, deduplicateTargets, limitTargets } from '../src/sarif-parser.js';
import {
  sanitizeUrl,
  normalizeUrl,
  parseGitUrl,
  normalizeRepoPath,
} from '../src/repository-analyzer.js';
import {
  checkMatchesRepository,
  filterChecksForRepository,
  parseCheckMarkdown,
  filterApplicablePaths,
  filterExcludedPaths,
  filterCheckPaths,
} from '../src/check-library.js';
import { isPathWithinRepository } from '../src/snippet-extractor.js';
import { formatError, formatFatalError } from '../src/error-codes.js';
import type { ErrorCode } from '../src/error-codes.js';
import { isValidLogLevel } from '../src/logging.js';
import { filterUnits, formatUnitPromptSection } from '../src/openant-loader.js';
import type { OpenAntUnit } from '../src/openant-loader.js';
import type { SecurityCheck, CheckTarget, OpenAntFilterConfig } from '../src/types.js';

// --- Shared Arbitraries ---

const checkTargetArb: fc.Arbitrary<CheckTarget> = fc.record({
  file: fc.string({ minLength: 1 }),
  startLine: fc.nat({ max: 10000 }),
  endLine: fc.nat({ max: 10000 }),
  message: fc.string(),
  snippet: fc.option(fc.string(), { nil: undefined }),
});

const aiIssueArb = fc.record({
  file: fc.string(),
  startLine: fc.integer(),
  endLine: fc.integer(),
  description: fc.string(),
  dataFlow: fc.option(
    fc.array(
      fc.record({
        file: fc.string(),
        lineNumber: fc.integer(),
        label: fc.string(),
      }),
    ),
    { nil: undefined },
  ),
});

const checkResponseArb = fc.record({
  issues: fc.array(aiIssueArb),
  flagged: fc.option(fc.boolean(), { nil: undefined }),
  summary: fc.option(fc.string(), { nil: undefined }),
  analysisNotes: fc.option(fc.string(), { nil: undefined }),
});

const securityCheckArb: fc.Arbitrary<SecurityCheck> = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string(),
  repositories: fc.array(fc.string()),
  enabled: fc.option(fc.boolean(), { nil: undefined }),
  applicablePaths: fc.option(fc.array(fc.string()), { nil: undefined }),
  excludedPaths: fc.option(fc.array(fc.string()), { nil: undefined }),
});

const openAntUnitArb: fc.Arbitrary<OpenAntUnit> = fc.record({
  id: fc.string({ minLength: 1 }),
  unit_type: fc.string({ minLength: 1 }),
  code: fc.record({
    primary_code: fc.string(),
    primary_origin: fc.record({
      file_path: fc.string({ minLength: 1 }),
      start_line: fc.nat({ max: 10000 }).map((n) => n + 1),
      end_line: fc.nat({ max: 10000 }).map((n) => n + 1),
      function_name: fc.string({ minLength: 1 }),
      class_name: fc.option(fc.string(), { nil: null }),
      enhanced: fc.boolean(),
      files_included: fc.array(fc.string()),
      original_length: fc.nat(),
      enhanced_length: fc.nat(),
    }),
    dependencies: fc.constant([]),
    dependency_metadata: fc.record({
      depth: fc.nat(),
      total_upstream: fc.nat(),
      total_downstream: fc.nat(),
      direct_calls: fc.nat(),
      direct_callers: fc.nat(),
    }),
  }),
  ground_truth: fc.record({ status: fc.string() }),
  metadata: fc.record({
    decorators: fc.array(fc.string()),
    is_async: fc.boolean(),
    parameters: fc.array(fc.string()),
    docstring: fc.option(fc.string(), { nil: null }),
    direct_calls: fc.array(fc.string()),
    direct_callers: fc.array(fc.string()),
  }),
  reachable: fc.boolean(),
  is_entry_point: fc.boolean(),
  entry_point_reason: fc.string(),
  agent_context: fc.option(
    fc.record({
      include_functions: fc.array(fc.record({ id: fc.string(), reason: fc.string() })),
      usage_context: fc.string(),
      security_classification: fc.string(),
      classification_reasoning: fc.string(),
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      agent_metadata: fc.record({
        iterations: fc.nat(),
        total_tokens: fc.nat(),
      }),
      reachability: fc.record({
        is_entry_point: fc.boolean(),
        reachable_from_entry: fc.boolean(),
        entry_point_path: fc.array(fc.string()),
      }),
    }),
    { nil: undefined },
  ),
});

const openAntFilterArb: fc.Arbitrary<OpenAntFilterConfig> = fc.record({
  unitTypes: fc.option(fc.array(fc.string()), { nil: undefined }),
  excludeUnitTypes: fc.option(fc.array(fc.string()), { nil: undefined }),
  securityClassifications: fc.option(fc.array(fc.string()), { nil: undefined }),
  reachableOnly: fc.option(fc.boolean(), { nil: undefined }),
  entryPointsOnly: fc.option(fc.boolean(), { nil: undefined }),
  minConfidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
});

const errorCodeArb: fc.Arbitrary<ErrorCode> = fc.record({
  code: fc.string({ minLength: 1 }),
  label: fc.string(),
});

// =========================================================================
// Tier 1: External Input Parsers (Security-Critical)
// =========================================================================

describe('fuzz: external input parsers', () => {
  describe('parseAgentResponse', () => {
    it('never crashes on arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = parseAgentResponse(input);
          assert.ok(result === undefined || (typeof result === 'object' && Array.isArray(result.issues)));
        }),
      );
    });

    it('never crashes on arbitrary JSON', () => {
      fc.assert(
        fc.property(fc.json(), (input) => {
          const result = parseAgentResponse(input);
          assert.ok(result === undefined || (typeof result === 'object' && Array.isArray(result.issues)));
        }),
      );
    });

    it('valid results have required fields', () => {
      fc.assert(
        fc.property(checkResponseArb, (response) => {
          const raw = JSON.stringify(response);
          const result = parseAgentResponse(raw);
          if (result !== undefined) {
            assert.ok(Array.isArray(result.issues));
            for (const issue of result.issues) {
              assert.equal(typeof issue.file, 'string');
              assert.equal(typeof issue.startLine, 'number');
              assert.equal(typeof issue.endLine, 'number');
              assert.equal(typeof issue.description, 'string');
            }
          }
        }),
      );
    });

    it('idempotent on valid output', () => {
      fc.assert(
        fc.property(checkResponseArb, (response) => {
          const raw = JSON.stringify(response);
          const first = parseAgentResponse(raw);
          if (first !== undefined) {
            const second = parseAgentResponse(JSON.stringify(first));
            assert.deepStrictEqual(second, first);
          }
        }),
      );
    });
  });

  describe('parseSARIF', () => {
    it('never crashes on arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          try {
            parseSARIF(input);
          } catch (e) {
            // Controlled errors (throws Error) are expected for invalid SARIF
            assert.ok(e instanceof Error);
          }
        }),
      );
    });

    it('valid output has required fields and startLine <= endLine', () => {
      // Generate valid-ish SARIF documents
      // Generate SARIF with startLine <= endLine (valid regions)
      const regionArb = fc.nat({ max: 10000 }).chain((start) =>
        fc.nat({ max: 10000 }).map((offset) => ({
          startLine: start + 1,
          endLine: start + offset + 1,
        })),
      );
      const sarifArb = fc.record({
        version: fc.constant('2.1.0'),
        runs: fc.array(
          fc.record({
            results: fc.array(
              fc.record({
                message: fc.record({ text: fc.string() }),
                locations: fc.array(
                  fc.record({
                    physicalLocation: fc.record({
                      artifactLocation: fc.record({ uri: fc.string({ minLength: 1 }) }),
                      region: regionArb,
                    }),
                  }),
                ),
              }),
            ),
          }),
        ),
      });

      fc.assert(
        fc.property(sarifArb, (doc) => {
          const targets = parseSARIF(JSON.stringify(doc));
          for (const target of targets) {
            assert.equal(typeof target.file, 'string');
            assert.equal(typeof target.startLine, 'number');
            assert.equal(typeof target.endLine, 'number');
            assert.equal(typeof target.message, 'string');
            assert.ok(target.startLine <= target.endLine);
          }
        }),
      );
    });
  });

  describe('sanitizeUrl', () => {
    it('never crashes on arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = sanitizeUrl(input);
          assert.equal(typeof result, 'string');
        }),
      );
    });

    it('never leaks credentials', () => {
      // Use a unique password marker that won't appear in host/path
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-z]{3,8}$/),
          fc.stringMatching(/^[a-z]{3,8}$/),
          (user, host) => {
            const pass = 'S3CRET_P4SS';
            const url = `https://${user}:${pass}@${host}.example.com/org/repo`;
            const sanitized = sanitizeUrl(url);
            assert.ok(!sanitized.includes(pass), `Sanitized URL should not contain password: ${sanitized}`);
          },
        ),
      );
    });

    it('is idempotent', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const once = sanitizeUrl(input);
          const twice = sanitizeUrl(once);
          assert.equal(twice, once);
        }),
      );
    });
  });

  describe('parseGitUrl', () => {
    it('never crashes on arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = parseGitUrl(input);
          assert.ok(
            result === undefined ||
            (typeof result === 'object' &&
              typeof result.org === 'string' &&
              typeof result.repo === 'string'),
          );
        }),
      );
    });

    it('valid results have non-empty org and repo', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = parseGitUrl(input);
          if (result !== undefined) {
            assert.ok(result.org.length > 0, 'org should be non-empty');
            assert.ok(result.repo.length > 0, 'repo should be non-empty');
          }
        }),
      );
    });
  });
});

// =========================================================================
// Tier 2: Pure Data Transformations (Strong Algebraic Properties)
// =========================================================================

describe('fuzz: data transformations', () => {
  describe('deduplicateTargets', () => {
    it('output is subset of input', () => {
      fc.assert(
        fc.property(fc.array(checkTargetArb), (targets) => {
          const result = deduplicateTargets(targets);
          assert.ok(result.length <= targets.length);
          for (const item of result) {
            assert.ok(targets.some((t) =>
              t.file === item.file &&
              t.startLine === item.startLine &&
              t.endLine === item.endLine,
            ));
          }
        }),
      );
    });

    it('is idempotent', () => {
      fc.assert(
        fc.property(fc.array(checkTargetArb), (targets) => {
          const once = deduplicateTargets(targets);
          const twice = deduplicateTargets(once);
          assert.deepStrictEqual(twice, once);
        }),
      );
    });

    it('no duplicate keys in output', () => {
      fc.assert(
        fc.property(fc.array(checkTargetArb), (targets) => {
          const result = deduplicateTargets(targets);
          const keys = result.map((t) => `${t.file}:${t.startLine}:${t.endLine}`);
          assert.equal(keys.length, new Set(keys).size);
        }),
      );
    });
  });

  describe('limitTargets', () => {
    it('respects maxTargets bound', () => {
      fc.assert(
        fc.property(fc.array(checkTargetArb), fc.nat({ max: 100 }), (targets, max) => {
          const result = limitTargets(targets, max);
          assert.ok(result.length <= max);
          assert.ok(result.length <= targets.length);
        }),
      );
    });

    it('preserves input order (prefix)', () => {
      fc.assert(
        fc.property(fc.array(checkTargetArb), fc.nat({ max: 100 }), (targets, max) => {
          const result = limitTargets(targets, max);
          for (let i = 0; i < result.length; i++) {
            assert.deepStrictEqual(result[i], targets[i]);
          }
        }),
      );
    });
  });

  describe('normalizeUrl', () => {
    it('never ends with .git or slash', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = normalizeUrl(input);
          assert.ok(!result.endsWith('.git'), `should not end with .git: ${result}`);
          assert.ok(!result.endsWith('/'), `should not end with /: ${result}`);
        }),
      );
    });

    it('is idempotent', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const once = normalizeUrl(input);
          const twice = normalizeUrl(once);
          assert.equal(twice, once);
        }),
      );
    });
  });

  describe('normalizeRepoPath', () => {
    it('output is lowercase with no backslashes', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = normalizeRepoPath(input);
          assert.equal(result, result.toLowerCase());
          assert.ok(!result.includes('\\'), `should not contain backslashes: ${result}`);
        }),
      );
    });

    it('is idempotent', () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const once = normalizeRepoPath(input);
          const twice = normalizeRepoPath(once);
          assert.equal(twice, once);
        }),
      );
    });
  });

  describe('filterApplicablePaths', () => {
    it('empty patterns returns all files', () => {
      fc.assert(
        fc.property(fc.array(fc.string()), (files) => {
          assert.deepStrictEqual(filterApplicablePaths(files, undefined), files);
          assert.deepStrictEqual(filterApplicablePaths(files, []), files);
        }),
      );
    });

    it('result is a subsequence of input', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[a-z0-9/.]+$/), { maxLength: 20 }),
          fc.array(fc.stringMatching(/^[a-z0-9*/.]+$/), { minLength: 1, maxLength: 3 }),
          (files, patterns) => {
            const result = filterApplicablePaths(files, patterns);
            assert.ok(result.length <= files.length);
            let lastIdx = -1;
            for (const r of result) {
              const idx = files.indexOf(r, lastIdx + 1);
              assert.ok(idx > lastIdx, 'result should be a subsequence');
              lastIdx = idx;
            }
          },
        ),
      );
    });
  });

  describe('filterExcludedPaths', () => {
    it('empty patterns returns all files', () => {
      fc.assert(
        fc.property(fc.array(fc.string()), (files) => {
          assert.deepStrictEqual(filterExcludedPaths(files, undefined), files);
          assert.deepStrictEqual(filterExcludedPaths(files, []), files);
        }),
      );
    });

    it('result is a subsequence of input', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[a-z0-9/.]+$/), { maxLength: 20 }),
          fc.array(fc.stringMatching(/^[a-z0-9*/.]+$/), { minLength: 1, maxLength: 3 }),
          (files, patterns) => {
            const result = filterExcludedPaths(files, patterns);
            assert.ok(result.length <= files.length);
            let lastIdx = -1;
            for (const r of result) {
              const idx = files.indexOf(r, lastIdx + 1);
              assert.ok(idx > lastIdx, 'result should be a subsequence');
              lastIdx = idx;
            }
          },
        ),
      );
    });
  });

  describe('filterCheckPaths', () => {
    it('equals compose of applicable + excluded filters', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[a-z0-9/.]+$/), { maxLength: 20 }),
          fc.option(fc.array(fc.stringMatching(/^[a-z0-9*/.]+$/), { maxLength: 3 }), { nil: undefined }),
          fc.option(fc.array(fc.stringMatching(/^[a-z0-9*/.]+$/), { maxLength: 3 }), { nil: undefined }),
          (files, applicablePaths, excludedPaths) => {
            const check: SecurityCheck = {
              id: 'test',
              name: 'Test',
              repositories: [],
              applicablePaths,
              excludedPaths,
            };
            const composed = filterExcludedPaths(
              filterApplicablePaths(files, applicablePaths),
              excludedPaths,
            );
            const direct = filterCheckPaths(files, check);
            assert.deepStrictEqual(direct, composed);
          },
        ),
      );
    });
  });

  describe('filterChecksForRepository', () => {
    it('no disabled checks in output', () => {
      fc.assert(
        fc.property(fc.array(securityCheckArb), fc.string(), (checks, url) => {
          const result = filterChecksForRepository(checks, url);
          for (const check of result) {
            assert.notEqual(check.enabled, false);
          }
        }),
      );
    });

    it('is idempotent', () => {
      fc.assert(
        fc.property(fc.array(securityCheckArb), fc.string(), (checks, url) => {
          const once = filterChecksForRepository(checks, url);
          const twice = filterChecksForRepository(once, url);
          assert.deepStrictEqual(twice, once);
        }),
      );
    });
  });
});

// =========================================================================
// Tier 3: Security-Sensitive Functions
// =========================================================================

describe('fuzz: security functions', () => {
  describe('isPathWithinRepository', () => {
    it('never crashes on arbitrary paths', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (repo, path) => {
          const result = isPathWithinRepository(repo, path);
          assert.equal(typeof result, 'boolean');
        }),
      );
    });

    it('returns true for genuine child paths', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
          fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), { minLength: 1, maxLength: 5 }),
          (base, segments) => {
            const repoPath = resolve('/', base);
            const childPath = join(repoPath, ...segments);
            const result = isPathWithinRepository(repoPath, childPath);
            assert.ok(result, `${childPath} should be within ${repoPath}`);
          },
        ),
      );
    });

    it('rejects path traversal escapes', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
          fc.array(fc.constant('..'), { minLength: 2, maxLength: 5 }),
          fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
          (base, ups, target) => {
            const repoPath = resolve('/', base);
            const escapePath = join(repoPath, ...ups, target);
            const result = isPathWithinRepository(repoPath, escapePath);
            // The resolved escape path should not be within the repo
            const resolvedEscape = resolve(escapePath);
            const resolvedRepo = resolve(repoPath) + sep;
            if (!resolvedEscape.startsWith(resolvedRepo)) {
              assert.equal(result, false, `${escapePath} should not be within ${repoPath}`);
            }
          },
        ),
      );
    });
  });

  describe('checkMatchesRepository', () => {
    it('empty repositories always matches', () => {
      fc.assert(
        fc.property(fc.string(), (url) => {
          const check: SecurityCheck = {
            id: 'test',
            name: 'Test',
            repositories: [],
          };
          assert.equal(checkMatchesRepository(check, url), true);
        }),
      );
    });

    it('never crashes on arbitrary URLs', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string()),
          fc.string(),
          (repos, url) => {
            const check: SecurityCheck = {
              id: 'test',
              name: 'Test',
              repositories: repos,
            };
            const result = checkMatchesRepository(check, url);
            assert.equal(typeof result, 'boolean');
          },
        ),
      );
    });
  });
});

// =========================================================================
// Tier 4: Formatting & Validation (Robustness)
// =========================================================================

describe('fuzz: formatting and validation', () => {
  describe('parseCheckMarkdown', () => {
    it('never crashes on arbitrary markdown', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (id, markdown) => {
          const result = parseCheckMarkdown(id, markdown);
          assert.ok(typeof result === 'object');
        }),
      );
    });

    it('preserves id and content', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (id, markdown) => {
          const result = parseCheckMarkdown(id, markdown);
          assert.equal(result.id, id);
          assert.equal(result.content, markdown);
        }),
      );
    });

    it('fallback name on missing heading', () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.string().filter((s) => !s.match(/^###\s+.+$/m)),
          (id, markdown) => {
            const result = parseCheckMarkdown(id, markdown);
            assert.equal(result.name, 'Unknown Check');
          },
        ),
      );
    });
  });

  describe('formatError', () => {
    it('output contains code and message', () => {
      fc.assert(
        fc.property(errorCodeArb, fc.string(), (code, message) => {
          const result = formatError(code, message);
          assert.ok(result.startsWith('Error ['), `should start with "Error [": ${result}`);
          assert.ok(result.includes(code.code), `should contain error code: ${result}`);
          assert.ok(result.includes(message), `should contain message: ${result}`);
        }),
      );
    });
  });

  describe('formatFatalError', () => {
    it('output contains E9001 and version', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (message, version) => {
          const result = formatFatalError(message, version);
          assert.ok(result.includes('E9001'), `should contain E9001: ${result}`);
          assert.ok(result.includes(version), `should contain version: ${result}`);
        }),
      );
    });

    it('output contains URL-encoded issue link', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (message, version) => {
          const result = formatFatalError(message, version);
          assert.ok(
            result.includes('github.com/owasp-aghast/aghast/issues/new'),
            `should contain issue link: ${result}`,
          );
        }),
      );
    });
  });

  describe('isValidLogLevel', () => {
    it('true only for valid levels', () => {
      const validLevels = ['error', 'warn', 'info', 'debug', 'trace'];
      for (const level of validLevels) {
        assert.equal(isValidLogLevel(level), true, `${level} should be valid`);
      }
    });

    it('false for all other strings including case variations', () => {
      fc.assert(
        fc.property(
          fc.string().filter(
            (s) => !['error', 'warn', 'info', 'debug', 'trace'].includes(s),
          ),
          (input) => {
            assert.equal(isValidLogLevel(input), false, `"${input}" should be invalid`);
          },
        ),
      );
    });
  });

  describe('filterUnits', () => {
    it('empty filters returns all units', () => {
      fc.assert(
        fc.property(fc.array(openAntUnitArb, { maxLength: 10 }), (units) => {
          assert.deepStrictEqual(filterUnits(units, undefined), units);
        }),
      );
    });

    it('result is a subsequence of input', () => {
      fc.assert(
        fc.property(
          fc.array(openAntUnitArb, { maxLength: 10 }),
          openAntFilterArb,
          (units, filters) => {
            const result = filterUnits(units, filters);
            assert.ok(result.length <= units.length);
            for (const item of result) {
              assert.ok(units.includes(item));
            }
          },
        ),
      );
    });

    it('reachableOnly returns only reachable units', () => {
      fc.assert(
        fc.property(fc.array(openAntUnitArb, { maxLength: 10 }), (units) => {
          const result = filterUnits(units, { reachableOnly: true });
          for (const unit of result) {
            assert.equal(unit.reachable, true);
          }
        }),
      );
    });

    it('entryPointsOnly returns only entry point units', () => {
      fc.assert(
        fc.property(fc.array(openAntUnitArb, { maxLength: 10 }), (units) => {
          const result = filterUnits(units, { entryPointsOnly: true });
          for (const unit of result) {
            assert.equal(unit.is_entry_point, true);
          }
        }),
      );
    });

    it('minConfidence filters correctly', () => {
      fc.assert(
        fc.property(
          fc.array(openAntUnitArb, { maxLength: 10 }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (units, minConf) => {
            const result = filterUnits(units, { minConfidence: minConf });
            for (const unit of result) {
              assert.ok(unit.agent_context !== undefined, 'filtered unit should have agent_context');
              assert.ok(unit.agent_context.confidence >= minConf,
                `confidence ${unit.agent_context.confidence} should be >= ${minConf}`);
            }
          },
        ),
      );
    });
  });

  describe('formatUnitPromptSection', () => {
    it('output contains file path and function name', () => {
      fc.assert(
        fc.property(openAntUnitArb, (unit) => {
          const result = formatUnitPromptSection(unit);
          const expectedPath = unit.code.primary_origin.file_path.replace(/\\/g, '/');
          assert.ok(
            result.includes(expectedPath),
            `should contain file path "${expectedPath}": ${result}`,
          );
          assert.ok(
            result.includes(unit.code.primary_origin.function_name),
            `should contain function name: ${result}`,
          );
        }),
      );
    });

    it('line numbers in output are >= 1', () => {
      fc.assert(
        fc.property(openAntUnitArb, (unit) => {
          const result = formatUnitPromptSection(unit);
          const lineMatch = result.match(/Lines:\s*(\d+)-(\d+)/);
          if (lineMatch) {
            assert.ok(parseInt(lineMatch[1]) >= 1, 'start line should be >= 1');
            assert.ok(parseInt(lineMatch[2]) >= 1, 'end line should be >= 1');
          }
        }),
      );
    });
  });
});
