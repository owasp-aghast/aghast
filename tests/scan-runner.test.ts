import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runMultiScan,
  generateScanId,
  sumTokenUsage,
} from '../src/scan-runner.js';
import { getRegisteredDiscoveries, registerDiscovery, unregisterDiscovery } from '../src/discovery.js';
import { DEFAULT_RETRY } from '../src/retry.js';
import type { SecurityCheck, CheckDetails } from '../src/types.js';
import type { AgentProvider, AgentResponse, CheckResponse } from '../src/types.js';
import { FatalProviderError } from '../src/types.js';
import {
  createPassProvider,
  createPassProviderWithTokens,
  createMalformedProvider,
  createTimeoutProvider,
  MockAgentProvider,
} from './mocks/mock-agent-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgVersion = (require('../package.json') as { version: string }).version;
const fixtureRepo = resolve(__dirname, 'fixtures', 'git-repo');
const multiTargetSarif = resolve(__dirname, 'fixtures', 'sarif', 'multi-target-3.sarif');
const multiTarget10Sarif = resolve(__dirname, 'fixtures', 'sarif', 'multi-target-10.sarif');
const emptySarif = resolve(__dirname, 'fixtures', 'sarif', 'empty-results.sarif');

describe('generateScanId', () => {
  it('follows scan-<timestamp>-<hash> format', () => {
    const id = generateScanId();
    assert.match(id, /^scan-\d{14}-[a-f0-9]{6}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateScanId()));
    assert.equal(ids.size, 10);
  });
});

// --- Helper to build check + details for runMultiScan ---

const sqlCheckContent = `### SQL Injection Prevention

#### Overview
Validates that database queries use parameterized queries or prepared statements instead of string concatenation.

#### What to Check
1. Identify all database query execution points
2. Check if user-supplied input is concatenated into SQL strings
3. Verify parameterized queries or ORM methods are used

#### Result
- **PASS**: All database queries use parameterized queries or ORM methods
- **FAIL**: Any database query uses string concatenation with user input

#### Recommendation
Replace string concatenation with parameterized queries. Use prepared statements or ORM query builders.
`;

function makeCheckAndDetails(
  id: string,
  name: string,
  content: string = '### ' + name + '\n\n#### Overview\nTest overview.\n',
): { check: SecurityCheck; details: CheckDetails } {
  return {
    check: {
      id,
      name,
      repositories: [],
      instructionsFile: 'unused-in-multi-scan.md',
    },
    details: {
      id,
      name,
      overview: 'Test overview.',
      content,
    },
  };
}

function makeSqlCheck(): { check: SecurityCheck; details: CheckDetails } {
  return makeCheckAndDetails('sql-check', 'SQL Injection Prevention', sqlCheckContent);
}

// --- runMultiScan tests (single check scenarios, formerly runScan) ---

describe('runMultiScan (single check)', () => {
  it('produces PASS result with empty issues', async () => {
    const provider = createPassProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.version, pkgVersion);
    assert.match(results.scanId, /^scan-\d{14}-[a-f0-9]{6}$/);
    assert.equal(results.repository.path, fixtureRepo);
    assert.equal(results.issues.length, 0);
    assert.equal(results.checks.length, 1);
    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].issuesFound, 0);
    assert.equal(results.summary.totalChecks, 1);
    assert.equal(results.summary.passedChecks, 1);
    assert.equal(results.summary.failedChecks, 0);
    assert.equal(results.summary.flaggedChecks, 0);
    assert.equal(results.summary.errorChecks, 0);
    assert.equal(results.summary.totalIssues, 0);
    assert.ok(results.startTime);
    assert.ok(results.endTime);
    assert.ok(results.executionTime >= 0);
    assert.equal(results.agentProvider.name, 'claude-code');
  });

  it('produces FAIL result with enriched issues', async () => {
    const provider = new MockAgentProvider({
      response: {
        issues: [
          {
            file: 'src/example.ts',
            startLine: 4,
            endLine: 4,
            description: 'SQL injection vulnerability found.',
          },
        ],
      },
    });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.checks[0].issuesFound, 1);
    assert.equal(results.issues.length, 1);

    const issue = results.issues[0];
    assert.equal(issue.file, 'src/example.ts');
    assert.equal(issue.startLine, 4);
    assert.equal(issue.endLine, 4);
    assert.equal(issue.description, 'SQL injection vulnerability found.');
    assert.ok(issue.checkId);
    assert.ok(issue.checkName);
    // codeSnippet should be extracted from the fixture file
    assert.ok(issue.codeSnippet);
    assert.ok(issue.codeSnippet!.includes('SELECT'));

    assert.equal(results.summary.failedChecks, 1);
    assert.equal(results.summary.totalIssues, 1);
  });

  it('produces ERROR result for malformed AI response', async () => {
    const provider = createMalformedProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'ERROR');
    assert.equal(results.checks[0].issuesFound, 0);
    assert.ok(results.checks[0].error);
    assert.ok(results.checks[0].rawAiResponse);
    assert.equal(results.issues.length, 0);
    assert.equal(results.summary.errorChecks, 1);
  });

  it('produces ERROR result when agent provider throws', async () => {
    const provider = createTimeoutProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'ERROR');
    assert.ok(results.checks[0].error);
    assert.ok(results.checks[0].error!.includes('timed out'));
    assert.equal(results.issues.length, 0);
    assert.equal(results.summary.errorChecks, 1);
  });

  it('tracks execution time', async () => {
    const provider = createPassProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.ok(results.checks[0].executionTime >= 0);
    assert.ok(results.executionTime >= 0);
  });

  it('sends prompt with check instructions to agent provider', async () => {
    const provider = createPassProvider();
    await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(provider.callHistory.length, 1);
    const call = provider.callHistory[0];
    // Prompt should contain the generic template
    assert.ok(call.instructions.includes('GENERIC INSTRUCTIONS'));
    assert.ok(call.instructions.includes('CHECK INSTRUCTIONS'));
    // And the check-specific content
    assert.ok(call.instructions.includes('SQL Injection Prevention'));
    assert.equal(call.repositoryPath, fixtureRepo);
  });

  it('handles issues for non-existent files gracefully (no codeSnippet)', async () => {
    const provider = new MockAgentProvider({
      response: {
        issues: [
          {
            file: 'nonexistent/file.ts',
            startLine: 1,
            endLine: 5,
            description: 'Issue in missing file.',
          },
        ],
      },
    });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.issues.length, 1);
    assert.equal(results.issues[0].codeSnippet, undefined);
  });

  it('ScanResults has valid timestamp format', async () => {
    const provider = createPassProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    // ISO 8601 format
    assert.ok(!isNaN(Date.parse(results.timestamp)));
    assert.ok(!isNaN(Date.parse(results.startTime)));
    assert.ok(!isNaN(Date.parse(results.endTime)));
  });

  it('propagates severity and confidence from check config to issues', async () => {
    const provider = new MockAgentProvider({
      response: {
        issues: [
          {
            file: 'src/example.ts',
            startLine: 4,
            endLine: 4,
            description: 'SQL injection vulnerability found.',
          },
        ],
      },
    });

    const checkWithMetadata = makeSqlCheck();
    checkWithMetadata.check.severity = 'high';
    checkWithMetadata.check.confidence = 'medium';

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [checkWithMetadata],
      agentProvider: provider,
    });

    const issue = results.issues[0];
    assert.equal(issue.severity, 'high');
    assert.equal(issue.confidence, 'medium');
  });

  it('issues have no severity/confidence when check config omits them', async () => {
    const provider = new MockAgentProvider({
      response: {
        issues: [
          {
            file: 'src/example.ts',
            startLine: 4,
            endLine: 4,
            description: 'Issue without metadata.',
          },
        ],
      },
    });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    const issue = results.issues[0];
    assert.equal(issue.severity, undefined);
    assert.equal(issue.confidence, undefined);
  });

  it('ScanResults does not have top-level branch or commit fields', async () => {
    const provider = createPassProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    // branch and commit should only be inside repository, not at top level
    const raw = JSON.parse(JSON.stringify(results));
    assert.equal(raw.branch, undefined, 'Should not have top-level branch');
    assert.equal(raw.commit, undefined, 'Should not have top-level commit');
  });
});

// --- runMultiScan tests (multiple checks) ---

describe('runMultiScan (multiple checks)', () => {
  it('aggregates results from multiple passing checks', async () => {
    const provider = createPassProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-1', 'Check One'),
        makeCheckAndDetails('check-2', 'Check Two'),
      ],
      agentProvider: provider,
    });

    assert.equal(results.checks.length, 2);
    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[1].status, 'PASS');
    assert.equal(results.summary.totalChecks, 2);
    assert.equal(results.summary.passedChecks, 2);
    assert.equal(results.summary.failedChecks, 0);
    assert.equal(results.summary.flaggedChecks, 0);
    assert.equal(results.summary.totalIssues, 0);
    assert.equal(results.issues.length, 0);
  });

  it('aggregates results from mix of PASS and FAIL checks', async () => {
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [] }, // PASS for first check
      {
        issues: [
          { file: 'src/example.ts', startLine: 4, endLine: 4, description: 'Issue found.' },
        ],
      }, // FAIL for second check
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-pass', 'Pass Check'),
        makeCheckAndDetails('check-fail', 'Fail Check'),
      ],
      agentProvider: provider,
    });

    assert.equal(results.summary.totalChecks, 2);
    assert.equal(results.summary.passedChecks, 1);
    assert.equal(results.summary.failedChecks, 1);
    assert.equal(results.summary.totalIssues, 1);
  });

  it('issues from all checks appear in flat list with correct checkId/checkName', async () => {
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      {
        issues: [
          { file: 'src/a.ts', startLine: 1, endLine: 1, description: 'Issue A.' },
        ],
      },
      {
        issues: [
          { file: 'src/b.ts', startLine: 2, endLine: 2, description: 'Issue B.' },
        ],
      },
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-a', 'Check A'),
        makeCheckAndDetails('check-b', 'Check B'),
      ],
      agentProvider: provider,
    });

    assert.equal(results.issues.length, 2);
    assert.equal(results.issues[0].checkId, 'check-a');
    assert.equal(results.issues[0].checkName, 'Check A');
    assert.equal(results.issues[1].checkId, 'check-b');
    assert.equal(results.issues[1].checkName, 'Check B');
  });

  it('handles ERROR in one check while other checks succeed', async () => {
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [] }, // PASS
    ]);
    // After queue is exhausted, second call will use the default rawResponse
    provider.setRawResponse('not valid json');

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-ok', 'OK Check'),
        makeCheckAndDetails('check-err', 'Error Check'),
      ],
      agentProvider: provider,
    });

    assert.equal(results.summary.totalChecks, 2);
    assert.equal(results.summary.passedChecks, 1);
    assert.equal(results.summary.errorChecks, 1);
    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[1].status, 'ERROR');
  });

  it('produces empty results when checks array is empty', async () => {
    const provider = createPassProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [],
      agentProvider: provider,
    });

    assert.equal(results.checks.length, 0);
    assert.equal(results.issues.length, 0);
    assert.equal(results.summary.totalChecks, 0);
    assert.equal(results.summary.passedChecks, 0);
    assert.equal(results.summary.failedChecks, 0);
    assert.equal(results.summary.flaggedChecks, 0);
    assert.equal(results.summary.errorChecks, 0);
    assert.equal(results.summary.totalIssues, 0);
  });

  it('executes checks sequentially (order preserved)', async () => {
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [] },
      { issues: [] },
      { issues: [] },
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('first', 'First'),
        makeCheckAndDetails('second', 'Second'),
        makeCheckAndDetails('third', 'Third'),
      ],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].checkId, 'first');
    assert.equal(results.checks[1].checkId, 'second');
    assert.equal(results.checks[2].checkId, 'third');
    assert.equal(provider.callHistory.length, 3);
  });
});

// --- runMultiScan tests (multi-target checks) ---

function makeMultiTargetCheck(
  overrides?: Partial<SecurityCheck>,
): { check: SecurityCheck; details: CheckDetails } {
  return {
    check: {
      id: 'mt-check',
      name: 'Multi-Target Check',
      repositories: [],
      instructionsFile: 'unused.md',
      checkTarget: {
        type: 'targeted', discovery: 'semgrep',
        rules: 'unused-in-mock.yaml',
      },
      ...overrides,
    },
    details: {
      id: 'mt-check',
      name: 'Multi-Target Check',
      overview: 'Test multi-target.',
      content: '### Multi-Target Check\n\n#### Overview\nTest multi-target.\n',
    },
  };
}

describe('runMultiScan (multi-target checks)', () => {
  const origMockSemgrep = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origMockSemgrep === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origMockSemgrep;
    }
  });

  it('3 targets all pass → PASS with targetsAnalyzed: 3', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].targetsAnalyzed, 3);
    assert.equal(results.issues.length, 0);
    assert.equal(provider.callHistory.length, 3);
  });

  it('3 targets, 1 has issues → FAIL with enriched issues', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [] }, // target 1: pass
      {
        issues: [{
          file: 'src/example.ts',
          startLine: 4,
          endLine: 4,
          description: 'SQL injection found.',
        }],
      }, // target 2: issue
      { issues: [] }, // target 3: pass
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.checks[0].targetsAnalyzed, 3);
    assert.equal(results.checks[0].issuesFound, 1);
    assert.equal(results.issues.length, 1);

    const issue = results.issues[0];
    assert.equal(issue.checkId, 'mt-check');
    assert.equal(issue.checkName, 'Multi-Target Check');
    assert.equal(issue.file, 'src/example.ts');
    assert.ok(issue.codeSnippet);
    assert.ok(issue.codeSnippet!.includes('SELECT'));
  });

  it('3 targets, 1 AI error → ERROR', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [] }, // target 1: pass
      { issues: [] }, // target 2: pass
    ]);
    // Third call throws (queue exhausted + error set)
    provider.setError(new Error('AI timeout'));

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'ERROR');
    assert.equal(results.checks[0].targetsAnalyzed, 3);
  });

  it('some targets error AND others find issues → FAIL (not ERROR)', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;

    // Custom provider: call 0 finds an issue, call 1 passes, call 2 throws
    let callCount = 0;
    const mixedProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck(_instructions: string, _repositoryPath: string) {
        const n = callCount++;
        if (n === 0) {
          const response = {
            issues: [{
              file: 'src/example.ts',
              startLine: 4,
              endLine: 4,
              description: 'SQL injection found.',
            }],
          };
          return { raw: JSON.stringify(response), parsed: response };
        }
        if (n === 1) {
          const response = { issues: [] };
          return { raw: JSON.stringify(response), parsed: response };
        }
        throw new Error('AI timeout');
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: mixedProvider,
    });

    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.checks[0].issuesFound, 1);
    assert.equal(results.issues.length, 1);
    assert.equal(results.checks[0].targetsAnalyzed, 3);
  });

  it('0 targets → PASS with targetsAnalyzed: 0', async () => {
    process.env.AGHAST_MOCK_SARIF = emptySarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].targetsAnalyzed, 0);
    assert.equal(results.issues.length, 0);
    assert.equal(provider.callHistory.length, 0); // no AI calls needed
  });

  it('maxTargets limiting applied via checkTarget.maxTargets', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck({
        checkTarget: { type: 'targeted', discovery: 'semgrep', rules: 'unused.yaml', maxTargets: 1 },
      })],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].targetsAnalyzed, 1);
    assert.equal(provider.callHistory.length, 1);
  });

  it('checkTarget.maxTargets=2 limits to 2 targets', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck({
        checkTarget: { type: 'targeted', discovery: 'semgrep', rules: 'unused.yaml', maxTargets: 2 },
      })],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].targetsAnalyzed, 2);
    assert.equal(provider.callHistory.length, 2);
  });

  it('target location embedded in prompt sent to agent provider', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(provider.callHistory.length, 3);

    // First target: src/example.ts:3-5
    assert.ok(provider.callHistory[0].instructions.includes('TARGET LOCATION:'));
    assert.ok(provider.callHistory[0].instructions.includes('- File: src/example.ts'));
    assert.ok(provider.callHistory[0].instructions.includes('- Lines: 3-5'));

    // Second target: src/example.ts:8-11
    assert.ok(provider.callHistory[1].instructions.includes('- File: src/example.ts'));
    assert.ok(provider.callHistory[1].instructions.includes('- Lines: 8-11'));

    // Third target: src/example.ts:1-2
    assert.ok(provider.callHistory[2].instructions.includes('- File: src/example.ts'));
    assert.ok(provider.callHistory[2].instructions.includes('- Lines: 1-2'));
  });

  it('agentOptions from discovery propagate to agent provider executeCheck', async () => {
    // Register a one-off test discovery that returns a single target with
    // a known agentOptions value, so we can assert the scan runner forwards
    // it to provider.executeCheck() without relying on a real discovery.
    const TEST_DISCOVERY = 'test-agent-options';
    // Guard against test-ordering issues: assert the name is not already
    // registered before we overwrite it with our test discovery. Non-mutating
    // so a leak-source test failure is not silently self-healed on rerun.
    assert.ok(
      !getRegisteredDiscoveries().includes(TEST_DISCOVERY),
      `${TEST_DISCOVERY} unexpectedly present in discovery registry — find and fix the leaking test`,
    );
    try {
      registerDiscovery({
        name: TEST_DISCOVERY,
        defaultGenericPrompt: 'generic-instructions.md',
        needsInstructions: false,
        async discover() {
          return [
            {
              file: 'src/example.ts',
              startLine: 1,
              endLine: 1,
              label: '[test target]',
              agentOptions: { maxTurns: 7 },
            },
          ];
        },
      });

      const provider = createPassProvider();
      await runMultiScan({
        repositoryPath: fixtureRepo,
        checks: [makeMultiTargetCheck({
          checkTarget: { type: 'targeted', discovery: TEST_DISCOVERY },
        })],
        agentProvider: provider,
      });

      assert.equal(provider.callHistory.length, 1);
      assert.deepEqual(provider.callHistory[0].options, { maxTurns: 7 });
    } finally {
      unregisterDiscovery(TEST_DISCOVERY);
    }
  });

  it('issues include codeSnippet from fixture file', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = new MockAgentProvider({
      response: {
        issues: [{
          file: 'src/example.ts',
          startLine: 4,
          endLine: 4,
          description: 'SQL injection.',
        }],
      },
    });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    // All 3 targets return the same issue
    assert.equal(results.issues.length, 3);
    for (const issue of results.issues) {
      assert.ok(issue.codeSnippet);
      assert.ok(issue.codeSnippet!.includes('SELECT'));
    }
  });

  it('severity and confidence propagated in multi-target mode', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = new MockAgentProvider({
      response: {
        issues: [{
          file: 'src/example.ts',
          startLine: 4,
          endLine: 4,
          description: 'Issue.',
        }],
      },
    });

    const check = makeMultiTargetCheck({ severity: 'high', confidence: 'medium' });
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [check],
      agentProvider: provider,
    });

    for (const issue of results.issues) {
      assert.equal(issue.severity, 'high');
      assert.equal(issue.confidence, 'medium');
    }
  });
});

// --- runMultiScan tests (false-positive-validation across checks) ---

function makeFpValidationCheck(
  id: string,
  name: string,
): { check: SecurityCheck; details: CheckDetails } {
  return {
    check: {
      id,
      name,
      repositories: [],
      instructionsFile: 'unused.md',
      checkTarget: {
        type: 'targeted',
        discovery: 'semgrep',
        rules: 'unused-in-mock.yaml',
        analysisMode: 'false-positive-validation',
      },
    },
    details: {
      id,
      name,
      overview: 'FP validation.',
      content: `### ${name}\n\n#### Overview\nFP validation.\n`,
    },
  };
}

describe('runMultiScan (false-positive-validation)', () => {
  const origMockSarif = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origMockSarif === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origMockSarif;
    }
  });

  it('offsets each validation issueIndex into the global issues array across checks', async () => {
    // Both checks run against the same 3 mock-Semgrep targets. Check A confirms
    // targets 0 and 2 (→ global issues 0,1); check B confirms only target 1
    // (→ global issue 2). The TP record from check B must have its issueIndex
    // offset by check A's issue count, i.e. point at index 2, not 0.
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;

    const tp = (desc: string): CheckResponse => ({
      issues: [{ file: 'src/example.ts', startLine: 4, endLine: 4, description: desc }],
      verdict: 'true-positive',
      rationale: 'Tainted input flows unsanitized into the sink.',
    });
    const fp = (): CheckResponse => ({
      issues: [],
      verdict: 'false-positive',
      rationale: 'The value is coerced to an integer before use.',
    });

    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      // Check A
      tp('A target0'),
      fp(),
      tp('A target2'),
      // Check B
      fp(),
      tp('B target1'),
      fp(),
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeFpValidationCheck('fp-check-a', 'FP Check A'),
        makeFpValidationCheck('fp-check-b', 'FP Check B'),
      ],
      agentProvider: provider,
    });

    // Global issues: A-target0, A-target2, B-target1
    assert.equal(results.issues.length, 3);
    assert.equal(results.issues[0].checkId, 'fp-check-a');
    assert.equal(results.issues[1].checkId, 'fp-check-a');
    assert.equal(results.issues[2].checkId, 'fp-check-b');

    const validations = results.validations!;
    assert.equal(validations.length, 6);

    // Every true-positive record's issueIndex must resolve to an issue from the
    // same check — proving the offset is applied correctly per check.
    for (const v of validations) {
      if (v.verdict === 'true-positive') {
        assert.equal(typeof v.issueIndex, 'number');
        assert.equal(results.issues[v.issueIndex!].checkId, v.checkId);
      } else {
        assert.equal(v.issueIndex, undefined);
      }
    }

    // Specifically, check B's confirmed target links to global index 2, not 0.
    const bTruePositive = validations.find(
      (v) => v.checkId === 'fp-check-b' && v.verdict === 'true-positive',
    )!;
    assert.equal(bTruePositive.issueIndex, 2);

    // Per-check validation counts stay attributed to the right check.
    assert.deepEqual(results.checks[0].validationsCount, { truePositive: 2, falsePositive: 1 });
    assert.deepEqual(results.checks[1].validationsCount, { truePositive: 1, falsePositive: 2 });
  });

  it('records a true positive when the AI verdict contradicts returned issues', async () => {
    // AI returns issues but labels the target a false positive. Issues are the
    // source of truth, so the record must be filed as a true positive and the
    // issue must still appear in results.issues.
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;

    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      {
        issues: [{ file: 'src/example.ts', startLine: 4, endLine: 4, description: 'Real issue' }],
        verdict: 'false-positive',
        rationale: 'Contradictory: claims false positive but reports an issue.',
      },
      { issues: [], verdict: 'false-positive', rationale: 'Genuinely safe.' },
      { issues: [], verdict: 'false-positive', rationale: 'Genuinely safe.' },
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeFpValidationCheck('fp-check', 'FP Check')],
      agentProvider: provider,
    });

    assert.equal(results.issues.length, 1);
    const validations = results.validations!;
    const confirmed = validations.filter((v) => v.verdict === 'true-positive');
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].issueIndex, 0);
    assert.equal(results.checks[0].validationsCount!.truePositive, 1);
    assert.equal(results.checks[0].validationsCount!.falsePositive, 2);
  });

  it('substitutes a sentinel rationale when the AI omits one', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;

    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [], verdict: 'false-positive' }, // no rationale
      { issues: [], verdict: 'false-positive', rationale: 'Safe.' },
      { issues: [], verdict: 'false-positive', rationale: 'Safe.' },
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeFpValidationCheck('fp-check', 'FP Check')],
      agentProvider: provider,
    });

    const missing = results.validations!.find((v) => v.rationale === '(no rationale provided)');
    assert.ok(missing, 'a record with the sentinel rationale should be present');
  });
});

// --- runMultiScan tests (concurrency) ---

/**
 * Create a tracking agent provider that records concurrency metrics.
 * Uses closures to safely track active/max under concurrent execution.
 */
function createTrackingProvider(
  delayMs: number,
  responseFn?: (callIndex: number) => CheckResponse,
): { provider: AgentProvider; getMaxActive: () => number; getCurrentActive: () => number } {
  let currentActive = 0;
  let maxActive = 0;
  let callIndex = 0;

  const provider: AgentProvider = {
    async initialize() {},
    async validateConfig() { return true; },
    async executeCheck(_instructions: string, _repositoryPath: string): Promise<AgentResponse> {
      const myIndex = callIndex++;
      currentActive++;
      if (currentActive > maxActive) maxActive = currentActive;
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const response = responseFn ? responseFn(myIndex) : { issues: [] };
        return { raw: JSON.stringify(response), parsed: response };
      } finally {
        currentActive--;
      }
    },
  };

  return {
    provider,
    getMaxActive: () => maxActive,
    getCurrentActive: () => currentActive,
  };
}

describe('runMultiScan (concurrency)', () => {
  const origMockSemgrep = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origMockSemgrep === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origMockSemgrep;
    }
  });

  it('concurrency limit respected (10 targets, concurrency 3)', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTarget10Sarif;
    const { provider, getMaxActive } = createTrackingProvider(50);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
      concurrency: 3,
    });

    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].targetsAnalyzed, 10);
    assert.ok(getMaxActive() <= 3, `maxActive ${getMaxActive()} should be <= 3`);
    assert.ok(getMaxActive() >= 2, `maxActive ${getMaxActive()} should be >= 2`);
  });

  it('default concurrency is 5 (10 targets, no concurrency specified)', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTarget10Sarif;
    const { provider, getMaxActive } = createTrackingProvider(50);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].targetsAnalyzed, 10);
    assert.ok(getMaxActive() <= 5, `maxActive ${getMaxActive()} should be <= 5`);
    assert.ok(getMaxActive() >= 2, `maxActive ${getMaxActive()} should be >= 2`);
  });

  it('per-check concurrency overrides MultiScanOptions concurrency', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTarget10Sarif;
    const { provider, getMaxActive } = createTrackingProvider(50);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck({
        checkTarget: { type: 'targeted', discovery: 'semgrep', rules: 'unused.yaml', concurrency: 2 },
      })],
      agentProvider: provider,
      concurrency: 10,
    });

    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].targetsAnalyzed, 10);
    assert.ok(getMaxActive() <= 2, `maxActive ${getMaxActive()} should be <= 2`);
  });

  it('result ordering preserved with variable delays', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif; // 3 targets
    const delays = [100, 10, 50];
    let callIdx = 0;

    const provider: AgentProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck(): Promise<AgentResponse> {
        const myIdx = callIdx++;
        const delay = delays[myIdx] ?? 10;
        await new Promise((resolve) => setTimeout(resolve, delay));
        const response: CheckResponse = {
          issues: [{
            file: `src/target-${myIdx}.ts`,
            startLine: myIdx + 1,
            endLine: myIdx + 1,
            description: `Issue from target ${myIdx}`,
          }],
        };
        return { raw: JSON.stringify(response), parsed: response };
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
      concurrency: 3,
    });

    assert.equal(results.issues.length, 3);
    // Issues should appear in target order (0, 1, 2) regardless of completion order
    assert.equal(results.issues[0].description, 'Issue from target 0');
    assert.equal(results.issues[1].description, 'Issue from target 1');
    assert.equal(results.issues[2].description, 'Issue from target 2');
  });

  it('single target works with concurrency 5', async () => {
    // Use multiTarget10Sarif with maxTargets: 1 to get a single target
    process.env.AGHAST_MOCK_SARIF = multiTarget10Sarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck({ checkTarget: { type: 'targeted', discovery: 'semgrep', rules: 'unused-in-mock.yaml', maxTargets: 1 } })],
      agentProvider: provider,
      concurrency: 5,
    });

    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].targetsAnalyzed, 1);
    assert.equal(provider.callHistory.length, 1);
  });
});

// --- runMultiScan tests (FLAG status) ---

describe('runMultiScan (FLAG status)', () => {
  const origMockSemgrep = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origMockSemgrep === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origMockSemgrep;
    }
  });

  it('single check: provider returns flagged:true → status FLAG, flaggedChecks=1', async () => {
    const provider = new MockAgentProvider({
      response: { issues: [], flagged: true },
    });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FLAG');
    assert.equal(results.checks[0].issuesFound, 0);
    assert.equal(results.summary.flaggedChecks, 1);
    assert.equal(results.summary.passedChecks, 0);
    assert.equal(results.summary.failedChecks, 0);
    assert.equal(results.summary.totalIssues, 0);
  });

  it('FAIL overrides FLAG: issues present even if flagged:true → FAIL', async () => {
    const provider = new MockAgentProvider({
      response: {
        issues: [{ file: 'src/example.ts', startLine: 4, endLine: 4, description: 'Issue.' }],
        flagged: true,
      },
    });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.summary.failedChecks, 1);
    assert.equal(results.summary.flaggedChecks, 0);
  });

  it('multi-target: all 3 targets flag → check status FLAG', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = new MockAgentProvider({
      response: { issues: [], flagged: true },
    });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FLAG');
    assert.equal(results.checks[0].targetsAnalyzed, 3);
    assert.equal(results.summary.flaggedChecks, 1);
  });

  it('multi-target: FLAG priority over ERROR (some flag, some error, no issues) → FLAG', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;

    // Calls 0 and 1 return flagged, call 2 throws
    let flagErrCallCount = 0;
    const mixedFlagProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck(_instructions: string, _repositoryPath: string) {
        const n = flagErrCallCount++;
        if (n < 2) {
          const response = { issues: [], flagged: true };
          return { raw: JSON.stringify(response), parsed: response };
        }
        throw new Error('AI timeout');
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: mixedFlagProvider,
    });

    assert.equal(results.checks[0].status, 'FLAG');
    assert.equal(results.summary.flaggedChecks, 1);
    assert.equal(results.summary.errorChecks, 0);
  });

  it('multi-target: FAIL overrides FLAG (some flag, one has issues) → FAIL', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [], flagged: true }, // target 1: flag
      {
        issues: [{ file: 'src/example.ts', startLine: 4, endLine: 4, description: 'Issue.' }],
      }, // target 2: fail
      { issues: [], flagged: true }, // target 3: flag
    ]);

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.summary.failedChecks, 1);
    assert.equal(results.summary.flaggedChecks, 0);
  });

  it('provider throws → ERROR; other checks in scan continue', async () => {
    let callCount = 0;
    const mixedProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck(_instructions: string, _repositoryPath: string) {
        const n = callCount++;
        // Fail for the first check's full retry budget (3 attempts) rather than
        // once. A "timed out" message is classified retryable, so a single
        // failure is now recovered — which is the point of retry, but would
        // make this test assert nothing. Exhausting the budget keeps the
        // original subject intact: a check that genuinely ERRORs must not stop
        // the checks after it from running.
        if (n < DEFAULT_RETRY.maxAttempts) {
          throw new Error('Agent provider request timed out after 60000ms');
        }
        const response = { issues: [] };
        return { raw: JSON.stringify(response), parsed: response };
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-1', 'Check One'),
        makeCheckAndDetails('check-2', 'Check Two'),
      ],
      agentProvider: mixedProvider,
      // Keep the backoff out of the test's wall-clock time.
      retry: { baseDelayMs: 1, maxDelayMs: 1 },
    });

    assert.equal(results.checks.length, 2);
    assert.equal(results.checks[0].status, 'ERROR');
    assert.ok(results.checks[0].error!.includes('timed out'));
    assert.equal(results.checks[1].status, 'PASS');
    assert.equal(results.summary.errorChecks, 1);
    assert.equal(results.summary.passedChecks, 1);
  });

  it('malformed response → ERROR with rawAiResponse populated', async () => {
    const provider = createMalformedProvider();
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'ERROR');
    assert.ok(results.checks[0].rawAiResponse, 'rawAiResponse should be populated');
    assert.ok((results.checks[0].rawAiResponse as string).length > 0);
  });

  it('3 checks, middle errors: all 3 summaries returned, errorChecks=1, passedChecks=2', async () => {
    const provider = new MockAgentProvider();
    provider.setResponseQueue([
      { issues: [] }, // check-1: PASS
    ]);
    // After queue exhausted, falls to rawResponse
    provider.setRawResponse('not valid json'); // check-2: ERROR (malformed)

    // For check-3, we need PASS again — but rawResponse is set to invalid now.
    // Use a custom approach: queue with 2 entries + raw for the third would be ERROR.
    // Instead, reset after queue exhaustion by adding a third response.
    provider.setResponseQueue([
      { issues: [] }, // check-1: PASS
      // check-2: will use rawResponse (malformed) → ERROR
      { issues: [] }, // this won't be reached for check-2
    ]);

    // Better approach: use a tracking provider
    let callCount2 = 0;
    const sequentialProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck(_instructions: string, _repositoryPath: string) {
        const n = callCount2++;
        if (n === 1) {
          // Middle check: return malformed
          return { raw: 'not valid json', parsed: undefined };
        }
        const response = { issues: [] };
        return { raw: JSON.stringify(response), parsed: response };
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-1', 'Check One'),
        makeCheckAndDetails('check-2', 'Check Two'),
        makeCheckAndDetails('check-3', 'Check Three'),
      ],
      agentProvider: sequentialProvider,
    });

    assert.equal(results.checks.length, 3);
    assert.equal(results.summary.totalChecks, 3);
    assert.equal(results.summary.errorChecks, 1);
    assert.equal(results.summary.passedChecks, 2);
    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[1].status, 'ERROR');
    assert.equal(results.checks[2].status, 'PASS');
  });
});

// --- runMultiScan tests (token usage) ---

describe('runMultiScan (token usage)', () => {
  const origMockSemgrep = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origMockSemgrep === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origMockSemgrep;
    }
  });

  it('single check: token usage propagated to check summary and scan results', async () => {
    const provider = createPassProviderWithTokens({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.ok(results.checks[0].tokenUsage, 'Check summary should have tokenUsage');
    assert.equal(results.checks[0].tokenUsage!.inputTokens, 100);
    assert.equal(results.checks[0].tokenUsage!.outputTokens, 50);
    assert.equal(results.checks[0].tokenUsage!.totalTokens, 150);

    assert.ok(results.tokenUsage, 'Scan results should have tokenUsage');
    assert.equal(results.tokenUsage!.inputTokens, 100);
    assert.equal(results.tokenUsage!.outputTokens, 50);
    assert.equal(results.tokenUsage!.totalTokens, 150);
  });

  it('multi-check: token usage aggregated across checks', async () => {
    const provider = createPassProviderWithTokens({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-1', 'Check One'),
        makeCheckAndDetails('check-2', 'Check Two'),
      ],
      agentProvider: provider,
    });

    // Each check gets 200/100/300
    assert.ok(results.tokenUsage, 'Scan results should have aggregated tokenUsage');
    assert.equal(results.tokenUsage!.inputTokens, 400);
    assert.equal(results.tokenUsage!.outputTokens, 200);
    assert.equal(results.tokenUsage!.totalTokens, 600);
  });

  it('no token usage from provider: fields undefined', async () => {
    const provider = createPassProvider(); // no tokenUsage
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].tokenUsage, undefined);
    assert.equal(results.tokenUsage, undefined);
  });

  it('multi-target: token usage aggregated across targets', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProviderWithTokens({ inputTokens: 50, outputTokens: 25, totalTokens: 75 });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeMultiTargetCheck()],
      agentProvider: provider,
    });

    // 3 targets × 50/25/75
    assert.ok(results.checks[0].tokenUsage, 'Multi-target check should have aggregated tokenUsage');
    assert.equal(results.checks[0].tokenUsage!.inputTokens, 150);
    assert.equal(results.checks[0].tokenUsage!.outputTokens, 75);
    assert.equal(results.checks[0].tokenUsage!.totalTokens, 225);

    assert.ok(results.tokenUsage, 'Scan results should have tokenUsage');
    assert.equal(results.tokenUsage!.totalTokens, 225);
  });

  it('ERROR check contributes no token usage (provider throws)', async () => {
    const provider = createTimeoutProvider(); // throws, no tokenUsage
    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSqlCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'ERROR');
    assert.equal(results.checks[0].tokenUsage, undefined);
    assert.equal(results.tokenUsage, undefined);
  });
});
// --- runMultiScan tests (semgrep-only checks) ---

function makeSemgrepOnlyCheck(
  overrides?: Partial<SecurityCheck>,
): { check: SecurityCheck; details: CheckDetails } {
  return {
    check: {
      id: 'sgo-check',
      name: 'Semgrep-Only Check',
      repositories: [],
      checkTarget: {
        type: 'static',
        discovery: 'semgrep',
        rules: 'unused-in-mock.yaml',
      },
      severity: 'high',
      confidence: 'high',
      ...overrides,
    },
    details: {
      id: 'sgo-check',
      name: 'Semgrep-Only Check',
      overview: '',
      content: '',
    },
  };
}

describe('runMultiScan (semgrep-only checks)', () => {
  const origMockSemgrep = process.env.AGHAST_MOCK_SARIF;

  afterEach(() => {
    if (origMockSemgrep === undefined) {
      delete process.env.AGHAST_MOCK_SARIF;
    } else {
      process.env.AGHAST_MOCK_SARIF = origMockSemgrep;
    }
  });

  it('0 findings → PASS, targetsAnalyzed: 0, no AI calls', async () => {
    process.env.AGHAST_MOCK_SARIF = emptySarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSemgrepOnlyCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'PASS');
    assert.equal(results.checks[0].targetsAnalyzed, 0);
    assert.equal(results.checks[0].issuesFound, 0);
    assert.equal(results.issues.length, 0);
    assert.equal(provider.callHistory.length, 0, 'No AI calls for semgrep-only');
  });

  it('3 findings → FAIL with correct SecurityIssue mapping', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSemgrepOnlyCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.checks[0].targetsAnalyzed, 3);
    assert.equal(results.checks[0].issuesFound, 3);
    assert.equal(results.issues.length, 3);
    assert.equal(provider.callHistory.length, 0, 'No AI calls for semgrep-only');

    // Verify issue mapping from SARIF targets
    const issue = results.issues[0];
    assert.equal(issue.checkId, 'sgo-check');
    assert.equal(issue.checkName, 'Semgrep-Only Check');
    assert.equal(issue.file, 'src/example.ts');
    assert.equal(issue.startLine, 3);
    assert.equal(issue.endLine, 5);
    // Description comes from SARIF message
    assert.ok(issue.description.length > 0, 'Description should be from SARIF message');
    // codeSnippet extracted from source file
    assert.ok(issue.codeSnippet, 'Should have codeSnippet from source file');
    assert.ok(issue.codeSnippet!.includes('SELECT'), 'Snippet should contain SQL from fixture');
  });

  it('severity and confidence from check config', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSemgrepOnlyCheck({ severity: 'critical', confidence: 'medium' })],
      agentProvider: provider,
    });

    for (const issue of results.issues) {
      assert.equal(issue.severity, 'critical');
      assert.equal(issue.confidence, 'medium');
    }
  });

  it('maxTargets limiting', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSemgrepOnlyCheck({
        checkTarget: { type: 'static', discovery: 'semgrep', rules: 'unused.yaml', maxTargets: 1 },
      })],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].targetsAnalyzed, 1);
    assert.equal(results.issues.length, 1);
    assert.equal(provider.callHistory.length, 0, 'No AI calls');
  });

  it('Semgrep failure → ERROR status', async () => {
    // No AGHAST_MOCK_SARIF set and no real semgrep → error
    delete process.env.AGHAST_MOCK_SARIF;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSemgrepOnlyCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].status, 'ERROR');
    assert.ok(results.checks[0].error, 'Should have error message');
    assert.equal(results.issues.length, 0);
    assert.equal(provider.callHistory.length, 0, 'No AI calls');
  });

  it('no tokenUsage on summary', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProviderWithTokens({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [makeSemgrepOnlyCheck()],
      agentProvider: provider,
    });

    assert.equal(results.checks[0].tokenUsage, undefined, 'semgrep-only should have no tokenUsage');
    assert.equal(results.tokenUsage, undefined, 'Aggregate tokenUsage should be undefined');
  });

  it('mixed check: semgrep-only + AI check both produce correct results', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;
    const provider = createPassProvider();

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeSemgrepOnlyCheck(),
        makeCheckAndDetails('ai-check', 'AI Check'),
      ],
      agentProvider: provider,
    });

    assert.equal(results.checks.length, 2);

    // semgrep-only check: FAIL with 3 findings, no AI
    assert.equal(results.checks[0].checkId, 'sgo-check');
    assert.equal(results.checks[0].status, 'FAIL');
    assert.equal(results.checks[0].targetsAnalyzed, 3);
    assert.equal(results.checks[0].issuesFound, 3);

    // AI check: PASS, AI was called
    assert.equal(results.checks[1].checkId, 'ai-check');
    assert.equal(results.checks[1].status, 'PASS');

    // Only the AI check should have called the provider
    assert.equal(provider.callHistory.length, 1, 'Only AI check should call provider');
  });
});

// --- Fatal error abort tests ---

describe('runMultiScan (fatal error abort)', () => {
  afterEach(() => {
    delete process.env.AGHAST_MOCK_SARIF;
  });

  it('FatalProviderError aborts remaining checks', async () => {
    let callCount = 0;
    const fatalProvider: AgentProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck() {
        const n = callCount++;
        if (n === 0) {
          // Check 1: PASS
          const response = { issues: [] };
          return { raw: JSON.stringify(response), parsed: response };
        }
        // Check 2: fatal error
        throw new FatalProviderError('Agent provider authentication failed (401)');
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-1', 'Check One'),
        makeCheckAndDetails('check-2', 'Check Two'),
        makeCheckAndDetails('check-3', 'Check Three'),
      ],
      agentProvider: fatalProvider,
    });

    assert.equal(results.checks.length, 3, 'All 3 checks should have summaries');
    assert.equal(results.checks[0].status, 'PASS', 'Check 1 should PASS');
    assert.equal(results.checks[1].status, 'ERROR', 'Check 2 should ERROR (fatal)');
    assert.ok(results.checks[1].error!.includes('authentication failed'), 'Check 2 error should mention auth');
    assert.equal(results.checks[2].status, 'ERROR', 'Check 3 should ERROR (aborted)');
    assert.ok(results.checks[2].error!.includes('Scan aborted'), 'Check 3 error should say aborted');
    assert.equal(results.summary.errorChecks, 2);
    assert.equal(results.summary.passedChecks, 1);
    assert.equal(callCount, 2, 'Provider should only be called twice (not for check 3)');
  });

  it('non-fatal errors still continue to next check (regression)', async () => {
    let callCount = 0;
    const mixedProvider: AgentProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck() {
        const n = callCount++;
        // Exhaust the first check's retry budget — see the note on the
        // "provider throws → ERROR" test above. A single retryable failure is
        // now recovered, so failing once would no longer produce an ERROR to
        // regress against.
        if (n < DEFAULT_RETRY.maxAttempts) {
          throw new Error('Agent provider request timed out after 60000ms');
        }
        const response = { issues: [] };
        return { raw: JSON.stringify(response), parsed: response };
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-1', 'Check One'),
        makeCheckAndDetails('check-2', 'Check Two'),
      ],
      agentProvider: mixedProvider,
      retry: { baseDelayMs: 1, maxDelayMs: 1 },
    });

    assert.equal(results.checks.length, 2);
    assert.equal(results.checks[0].status, 'ERROR');
    assert.equal(results.checks[1].status, 'PASS');
    // Check one exhausts its retry budget, then check two succeeds on one call.
    // The statuses above are what this test is really about — that a failing
    // check does not stop the next one — but the call count is worth pinning
    // too, since a regression that skipped the second check entirely would
    // otherwise still satisfy the status assertions.
    assert.equal(
      callCount,
      DEFAULT_RETRY.maxAttempts + 1,
      'check one should use its full retry budget, then check two runs once',
    );
  });

  it('FatalProviderError on first check aborts all remaining', async () => {
    const fatalProvider: AgentProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck() {
        throw new FatalProviderError('Agent provider rate limit reached');
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        makeCheckAndDetails('check-1', 'Check One'),
        makeCheckAndDetails('check-2', 'Check Two'),
      ],
      agentProvider: fatalProvider,
    });

    assert.equal(results.checks.length, 2, 'Both checks should have summaries');
    assert.equal(results.checks[0].status, 'ERROR', 'Check 1 should ERROR (fatal)');
    assert.ok(results.checks[0].error!.includes('rate limit'), 'Check 1 error should mention rate limit');
    assert.equal(results.checks[1].status, 'ERROR', 'Check 2 should ERROR (aborted)');
    assert.ok(results.checks[1].error!.includes('Scan aborted'), 'Check 2 error should say aborted');
  });

  it('FatalProviderError in multi-target check aborts remaining checks', async () => {
    process.env.AGHAST_MOCK_SARIF = multiTargetSarif;

    const fatalProvider: AgentProvider = {
      async initialize() {},
      async validateConfig() { return true; },
      async executeCheck() {
        throw new FatalProviderError('Agent provider authentication failed (401)');
      },
    };

    const multiTargetCheck: { check: SecurityCheck; details: CheckDetails } = {
      check: {
        id: 'mt-check',
        name: 'Multi-target Check',
        repositories: [],
        instructionsFile: 'mt-check.md',
        checkTarget: { type: 'targeted', discovery: 'semgrep', rules: 'rule.yaml' },
      },
      details: {
        id: 'mt-check',
        name: 'Multi-target Check',
        overview: 'Test.',
        content: '### Multi-target\n\n#### Overview\nTest.\n',
      },
    };

    const results = await runMultiScan({
      repositoryPath: fixtureRepo,
      checks: [
        multiTargetCheck,
        makeCheckAndDetails('check-2', 'Check Two'),
      ],
      agentProvider: fatalProvider,
    });

    assert.equal(results.checks.length, 2, 'Both checks should have summaries');
    assert.equal(results.checks[0].status, 'ERROR', 'Multi-target check should ERROR');
    assert.ok(results.checks[0].error!.includes('authentication failed'), 'Should mention auth error');
    assert.equal(results.checks[1].status, 'ERROR', 'Check 2 should ERROR (aborted)');
    assert.ok(results.checks[1].error!.includes('Scan aborted'), 'Check 2 should say aborted');
  });
});

describe('sumTokenUsage', () => {
  it('returns undefined when all inputs are undefined', () => {
    assert.equal(sumTokenUsage([undefined, undefined]), undefined);
  });

  it('returns undefined for empty array', () => {
    assert.equal(sumTokenUsage([]), undefined);
  });

  it('sums basic fields across multiple entries', () => {
    const result = sumTokenUsage([
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
    ]);
    assert.ok(result);
    assert.equal(result!.inputTokens, 300);
    assert.equal(result!.outputTokens, 125);
    assert.equal(result!.totalTokens, 425);
  });

  it('sums cache and reasoning tokens when present', () => {
    const result = sumTokenUsage([
      { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, reasoningTokens: 10 },
      { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadInputTokens: 500, cacheCreationInputTokens: 100, reasoningTokens: 5 },
    ]);
    assert.ok(result);
    assert.equal(result!.cacheReadInputTokens, 1500);
    assert.equal(result!.cacheCreationInputTokens, 300);
    assert.equal(result!.reasoningTokens, 15);
  });

  it('preserves undefined for cache fields when all inputs omit them', () => {
    const result = sumTokenUsage([
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    ]);
    assert.ok(result);
    assert.equal(result!.cacheReadInputTokens, undefined);
    assert.equal(result!.cacheCreationInputTokens, undefined);
    assert.equal(result!.reasoningTokens, undefined);
  });

  it('aggregates reportedCost when all inputs have it', () => {
    const result = sumTokenUsage([
      { inputTokens: 100, outputTokens: 50, totalTokens: 150, reportedCost: { amountUsd: 0.01, source: 'claude-agent-sdk' } },
      { inputTokens: 200, outputTokens: 75, totalTokens: 275, reportedCost: { amountUsd: 0.02, source: 'claude-agent-sdk' } },
    ]);
    assert.ok(result);
    assert.ok(result!.reportedCost);
    assert.equal(result!.reportedCost!.amountUsd, 0.03);
    assert.equal(result!.reportedCost!.source, 'claude-agent-sdk');
  });

  it('sets reportedCost to undefined when any input is missing it', () => {
    const result = sumTokenUsage([
      { inputTokens: 100, outputTokens: 50, totalTokens: 150, reportedCost: { amountUsd: 0.01, source: 'claude-agent-sdk' } },
      { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
    ]);
    assert.ok(result);
    assert.equal(result!.reportedCost, undefined);
  });

  it('skips undefined entries in the array', () => {
    const result = sumTokenUsage([
      undefined,
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      undefined,
    ]);
    assert.ok(result);
    assert.equal(result!.inputTokens, 100);
  });
});
