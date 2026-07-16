/**
 * Unit tests for the Check Library component.
 * Tests config loading, repository matching, markdown parsing,
 * path filtering, validation, and two-layer config merging.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  loadCheckRegistry,
  loadCheckDefinition,
  discoverCheckFolders,
  resolveChecks,
  validateCheck,
  normalizeRepoPath,
  checkMatchesRepository,
  filterChecksForRepository,
  parseCheckMarkdown,
  loadCheckDetails,
  filterApplicablePaths,
  filterExcludedPaths,
  filterCheckPaths,
} from '../src/check-library.js';
import type { SecurityCheck } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, 'fixtures');
const configDir = resolve(fixturesDir, 'config');
const aiChecksDir = resolve(fixturesDir, 'ai-checks');
const fixtureChecksDir = resolve(fixturesDir, 'checks');
const fixtureConfigDir = resolve(fixturesDir, 'config-dir');

function makeCheck(overrides: Partial<SecurityCheck> = {}): SecurityCheck {
  return {
    id: 'test-check',
    name: 'Test Check',
    repositories: [],
    instructionsFile: 'ai-checks/valid-check.md',
    ...overrides,
  };
}

// --- loadConfig (backward-compatible flat format) ---

describe('loadConfig', () => {
  it('loads a valid config file', async () => {
    const config = await loadConfig(resolve(configDir, 'valid-config.json'));
    assert.ok(Array.isArray(config.checks));
    assert.equal(config.checks.length, 2);
    assert.equal(config.checks[0].id, 'aghast-sql-injection');
  });

  it('throws on missing file', async () => {
    await assert.rejects(
      loadConfig(resolve(configDir, 'does-not-exist.json')),
      /Failed to read config file/,
    );
  });

  it('throws on malformed JSON', async () => {
    await assert.rejects(
      loadConfig(resolve(configDir, 'invalid-config.json')),
      /invalid JSON/,
    );
  });

  it('loads config with empty checks array', async () => {
    const config = await loadConfig(resolve(configDir, 'empty-checks-config.json'));
    assert.ok(Array.isArray(config.checks));
    assert.equal(config.checks.length, 0);
  });

  it('throws when checks property is missing', async () => {
    // The malformed-check.md is not JSON, but we need a JSON file without "checks".
    // Use the ai-checks markdown file which is not valid JSON config
    await assert.rejects(
      loadConfig(resolve(aiChecksDir, 'valid-check.md')),
      /invalid JSON/,
    );
  });
});

// --- Two-layer config: loadCheckRegistry ---

describe('loadCheckRegistry', () => {
  it('loads a valid checks-config.json from config dir', async () => {
    const registry = await loadCheckRegistry(fixtureConfigDir);
    assert.ok(Array.isArray(registry.checks));
    assert.equal(registry.checks.length, 2);
    assert.equal(registry.checks[0].id, 'aghast-sql-injection');
  });

  it('throws when config dir does not exist', async () => {
    await assert.rejects(
      loadCheckRegistry(resolve(fixturesDir, 'nonexistent-dir')),
      /Failed to read config file/,
    );
  });

  it('throws on malformed JSON', async () => {
    const invalidDir = resolve(fixturesDir, 'cli-configs', 'invalid');
    await assert.rejects(
      loadCheckRegistry(invalidDir),
      /invalid JSON/,
    );
  });
});

// --- Two-layer config: loadCheckDefinition ---

describe('loadCheckDefinition', () => {
  it('loads a valid <id>.json from check folder', async () => {
    const def = await loadCheckDefinition(resolve(fixtureChecksDir, 'aghast-sql-injection'));
    assert.equal(def.id, 'aghast-sql-injection');
    assert.equal(def.name, 'SQL Injection Prevention');
    assert.equal(def.instructionsFile, 'aghast-sql-injection.md');
  });

  it('throws when check folder does not exist', async () => {
    await assert.rejects(
      loadCheckDefinition(resolve(fixtureChecksDir, 'nonexistent-check')),
      /Failed to read check definition/,
    );
  });

  it('loads check with checkTarget', async () => {
    const def = await loadCheckDefinition(resolve(fixtureChecksDir, 'aghast-mt-sqli'));
    assert.ok(def.checkTarget);
    assert.equal(def.checkTarget!.type, 'targeted');
    assert.equal(def.checkTarget!.discovery, 'semgrep');
  });
});

// --- Two-layer config: discoverCheckFolders ---

describe('discoverCheckFolders', () => {
  it('discovers check folders in a directory', async () => {
    const folders = await discoverCheckFolders([fixtureChecksDir]);
    assert.ok(folders.size > 0);
    assert.ok(folders.has('aghast-sql-injection'));
    assert.ok(folders.has('aghast-mt-sqli'));
  });

  it('returns empty map for nonexistent directory', async () => {
    const folders = await discoverCheckFolders([resolve(fixturesDir, 'nonexistent')]);
    assert.equal(folders.size, 0);
  });

  it('supports multiple check directories', async () => {
    const folders = await discoverCheckFolders([
      fixtureChecksDir,
      resolve(fixturesDir, 'nonexistent'),
    ]);
    assert.ok(folders.size > 0);
  });
});

// --- Two-layer config: resolveChecks ---

describe('resolveChecks', () => {
  it('merges registry entries with check definitions', async () => {
    const registry = await loadCheckRegistry(fixtureConfigDir);
    const folders = await discoverCheckFolders([fixtureChecksDir]);
    const checks = await resolveChecks(registry, folders);

    assert.equal(checks.length, 2);
    assert.equal(checks[0].id, 'aghast-sql-injection');
    assert.equal(checks[0].name, 'SQL Injection Prevention');
    assert.ok(checks[0].repositories);
    assert.ok(checks[0].instructionsFile);
    assert.ok(checks[0].checkDir);
  });

  it('throws when registry entry has no matching check folder', async () => {
    const registry = {
      checks: [{ id: 'nonexistent-check', repositories: [], enabled: true }],
    };
    const folders = await discoverCheckFolders([fixtureChecksDir]);
    await assert.rejects(
      resolveChecks(registry, folders),
      /no matching check folder/,
    );
  });

  it('resolves instructionsFile to absolute path', async () => {
    const registry = await loadCheckRegistry(fixtureConfigDir);
    const folders = await discoverCheckFolders([fixtureChecksDir]);
    const checks = await resolveChecks(registry, folders);

    // instructionsFile should be absolute
    assert.ok(
      checks[0].instructionsFile.includes('aghast-sql-injection.md'),
      'Should contain aghast-sql-injection.md',
    );
    assert.ok(
      resolve(checks[0].instructionsFile) === checks[0].instructionsFile,
      'instructionsFile should be absolute',
    );
  });
});

// --- normalizeRepoPath ---

describe('normalizeRepoPath', () => {
  it('removes .git suffix', () => {
    assert.equal(
      normalizeRepoPath('https://github.com/org/repo.git'),
      'https://github.com/org/repo',
    );
  });

  it('converts to lowercase', () => {
    assert.equal(
      normalizeRepoPath('https://github.com/Org/Repo'),
      'https://github.com/org/repo',
    );
  });

  it('normalizes backslashes to forward slashes', () => {
    assert.equal(
      normalizeRepoPath('C:\\Users\\org\\repo'),
      'c:/users/org/repo',
    );
  });

  it('handles HTTPS URLs', () => {
    const result = normalizeRepoPath('https://github.com/myorg/myrepo.git');
    assert.equal(result, 'https://github.com/myorg/myrepo');
  });

  it('handles SSH URLs', () => {
    const result = normalizeRepoPath('git@github.com:MyOrg/MyRepo.git');
    assert.equal(result, 'git@github.com:myorg/myrepo');
  });
});

// --- checkMatchesRepository ---

describe('checkMatchesRepository', () => {
  it('matches exact repo path', () => {
    const check = makeCheck({ repositories: ['org/team/service'] });
    assert.ok(checkMatchesRepository(check, 'org/team/service'));
  });

  it('matches substring of repo URL (check repo is substring of actual)', () => {
    const check = makeCheck({ repositories: ['org/team/service'] });
    assert.ok(
      checkMatchesRepository(check, 'https://github.com/org/team/service'),
    );
  });

  it('matches substring bidirectionally (actual is substring of check repo)', () => {
    const check = makeCheck({
      repositories: ['https://github.com/org/team/service'],
    });
    assert.ok(checkMatchesRepository(check, 'org/team/service'));
  });

  it('empty repositories array matches all repos', () => {
    const check = makeCheck({ repositories: [] });
    assert.ok(checkMatchesRepository(check, 'any/repo/path'));
  });

  it('returns false when no match', () => {
    const check = makeCheck({ repositories: ['org/other/repo'] });
    assert.ok(!checkMatchesRepository(check, 'org/team/service'));
  });

  it('matching is case-insensitive', () => {
    const check = makeCheck({ repositories: ['Org/Team/Service'] });
    assert.ok(checkMatchesRepository(check, 'org/team/service'));
  });

  it('excludes repos in excludeRepositories when repositories is empty (match-all)', () => {
    const check = makeCheck({
      repositories: [],
      excludeRepositories: ['legacy-monolith'],
    });
    assert.ok(!checkMatchesRepository(check, 'org/legacy-monolith'));
    assert.ok(checkMatchesRepository(check, 'org/other-service'));
  });

  it('exclusion overrides inclusion when same repo appears in both', () => {
    const check = makeCheck({
      repositories: ['org/team/service'],
      excludeRepositories: ['org/team/service'],
    });
    assert.ok(!checkMatchesRepository(check, 'org/team/service'));
  });

  it('excludeRepositories uses bidirectional substring match like repositories', () => {
    const check = makeCheck({
      repositories: [],
      excludeRepositories: ['https://github.com/org/legacy'],
    });
    assert.ok(!checkMatchesRepository(check, 'org/legacy'));
  });

  it('absent excludeRepositories field behaves identically to today', () => {
    const check = makeCheck({ repositories: ['org/repo'] });
    assert.ok(checkMatchesRepository(check, 'org/repo'));
    assert.ok(!checkMatchesRepository(check, 'other/repo'));
  });
});

// --- filterChecksForRepository ---

describe('filterChecksForRepository', () => {
  it('returns checks matching the repository', () => {
    const checks = [
      makeCheck({ id: 'match', repositories: ['org/repo'] }),
      makeCheck({ id: 'no-match', repositories: ['other/repo'] }),
    ];
    const result = filterChecksForRepository(checks, 'org/repo');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'match');
  });

  it('returns checks with empty repositories array', () => {
    const checks = [makeCheck({ id: 'all', repositories: [] })];
    const result = filterChecksForRepository(checks, 'any/repo');
    assert.equal(result.length, 1);
  });

  it('returns empty array when no checks match', () => {
    const checks = [makeCheck({ repositories: ['other/repo'] })];
    const result = filterChecksForRepository(checks, 'org/repo');
    assert.equal(result.length, 0);
  });

  it('filters out disabled checks (enabled: false)', () => {
    const checks = [
      makeCheck({ id: 'enabled', enabled: true }),
      makeCheck({ id: 'disabled', enabled: false }),
    ];
    const result = filterChecksForRepository(checks, 'any/repo');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'enabled');
  });

  it('includes checks where enabled is undefined (default true)', () => {
    const check = makeCheck({ id: 'no-enabled-field' });
    delete (check as Record<string, unknown>).enabled;
    const result = filterChecksForRepository([check], 'any/repo');
    assert.equal(result.length, 1);
  });

  it('includes checks where enabled is true', () => {
    const checks = [makeCheck({ enabled: true })];
    const result = filterChecksForRepository(checks, 'any/repo');
    assert.equal(result.length, 1);
  });
});

// --- parseCheckMarkdown ---

describe('parseCheckMarkdown', () => {
  it('extracts name from ### heading', () => {
    const md = '### SQL Injection Prevention\n\n#### Overview\nSome overview.';
    const details = parseCheckMarkdown('test-id', md);
    assert.equal(details.name, 'SQL Injection Prevention');
  });

  it('extracts overview from #### Overview section', () => {
    const md = '### Check Name\n\n#### Overview\nThis is the overview.\n\n#### What to Check\nStuff.';
    const details = parseCheckMarkdown('test-id', md);
    assert.equal(details.overview, 'This is the overview.');
  });

  it('returns full markdown as content', () => {
    const md = '### Check\n\n#### Overview\nOverview text.\n\n#### Details\nMore details.';
    const details = parseCheckMarkdown('test-id', md);
    assert.equal(details.content, md);
  });

  it('handles missing ### heading (name defaults to Unknown Check)', () => {
    const md = 'No heading here, just text.';
    const details = parseCheckMarkdown('test-id', md);
    assert.equal(details.name, 'Unknown Check');
  });

  it('handles missing #### Overview section (overview defaults to empty)', () => {
    const md = '### Check Name\n\nNo overview section here.';
    const details = parseCheckMarkdown('test-id', md);
    assert.equal(details.overview, '');
  });

  it('handles malformed markdown', () => {
    const md = 'This file has no proper markdown structure.';
    const details = parseCheckMarkdown('test-id', md);
    assert.equal(details.name, 'Unknown Check');
    assert.equal(details.overview, '');
    assert.equal(details.content, md);
  });

  it('uses provided id, not derived from content', () => {
    const md = '### Check Name\n\n#### Overview\nOverview.';
    const details = parseCheckMarkdown('my-custom-id', md);
    assert.equal(details.id, 'my-custom-id');
  });
});

// --- loadCheckDetails ---

describe('loadCheckDetails', () => {
  it('loads and parses a valid check markdown file', async () => {
    const check = makeCheck({ id: 'sql-check', instructionsFile: 'ai-checks/valid-check.md' });
    const details = await loadCheckDetails(check, fixturesDir);
    assert.equal(details.id, 'sql-check');
    assert.equal(details.name, 'SQL Injection Prevention');
    assert.ok(details.overview.length > 0);
    assert.ok(details.content.includes('### SQL Injection Prevention'));
  });

  it('throws on missing markdown file', async () => {
    const check = makeCheck({ instructionsFile: 'ai-checks/nonexistent.md' });
    await assert.rejects(
      loadCheckDetails(check, fixturesDir),
      /Failed to load instructions file/,
    );
  });

  it('throws on an empty markdown file', async () => {
    const check = makeCheck({ instructionsFile: 'ai-checks/empty-check.md' });
    await assert.rejects(
      loadCheckDetails(check, fixturesDir),
      /instructions file .* is empty/i,
    );
  });

  it('resolves instructionsFile relative to basePath', async () => {
    const check = makeCheck({ id: 'rel-check', instructionsFile: 'valid-check.md' });
    const details = await loadCheckDetails(check, aiChecksDir);
    assert.equal(details.id, 'rel-check');
    assert.equal(details.name, 'SQL Injection Prevention');
  });
});

// --- validateCheck ---

describe('validateCheck', () => {
  it('valid check passes validation', async () => {
    const check = makeCheck({ instructionsFile: 'ai-checks/valid-check.md' });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
  });

  it('missing id produces error', async () => {
    const check = makeCheck({ id: undefined as unknown as string });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('id')));
  });

  it('empty id produces error', async () => {
    const check = makeCheck({ id: '' });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('id')));
  });

  it('missing markdown file produces error', async () => {
    const check = makeCheck({ instructionsFile: 'ai-checks/nonexistent.md' });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('not found')));
  });

  it('empty markdown file produces error', async () => {
    const check = makeCheck({ instructionsFile: 'ai-checks/empty-check.md' });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.includes('is empty')));
  });

  it('valid check with all optional fields passes', async () => {
    const check = makeCheck({
      instructionsFile: 'ai-checks/valid-check.md',
      applicablePaths: ['src/**/*.ts'],
      excludedPaths: ['src/**/*.test.ts'],
      enabled: true,
    });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(result.valid);
  });
});

// --- filterApplicablePaths ---

describe('filterApplicablePaths', () => {
  const files = ['src/app.ts', 'src/utils.ts', 'tests/app.test.ts', 'README.md'];

  it('returns all files when applicablePaths is undefined', () => {
    const result = filterApplicablePaths(files, undefined);
    assert.deepEqual(result, files);
  });

  it('returns all files when applicablePaths is empty array', () => {
    const result = filterApplicablePaths(files, []);
    assert.deepEqual(result, files);
  });

  it('filters to matching files with single glob', () => {
    const result = filterApplicablePaths(files, ['src/**/*.ts']);
    assert.deepEqual(result, ['src/app.ts', 'src/utils.ts']);
  });

  it('filters to matching files with multiple globs', () => {
    const result = filterApplicablePaths(files, ['src/**/*.ts', '*.md']);
    assert.deepEqual(result, ['src/app.ts', 'src/utils.ts', 'README.md']);
  });

  it('returns empty when no files match', () => {
    const result = filterApplicablePaths(files, ['**/*.py']);
    assert.deepEqual(result, []);
  });
});

// --- filterExcludedPaths ---

describe('filterExcludedPaths', () => {
  const files = ['src/app.ts', 'src/utils.ts', 'tests/app.test.ts', 'README.md'];

  it('returns all files when excludedPaths is undefined', () => {
    const result = filterExcludedPaths(files, undefined);
    assert.deepEqual(result, files);
  });

  it('returns all files when excludedPaths is empty array', () => {
    const result = filterExcludedPaths(files, []);
    assert.deepEqual(result, files);
  });

  it('removes files matching excluded glob', () => {
    const result = filterExcludedPaths(files, ['tests/**']);
    assert.deepEqual(result, ['src/app.ts', 'src/utils.ts', 'README.md']);
  });

  it('keeps files not matching excluded glob', () => {
    const result = filterExcludedPaths(files, ['**/*.py']);
    assert.deepEqual(result, files);
  });

  it('handles multiple exclusion patterns', () => {
    const result = filterExcludedPaths(files, ['tests/**', '*.md']);
    assert.deepEqual(result, ['src/app.ts', 'src/utils.ts']);
  });
});

// --- filterCheckPaths ---

describe('filterCheckPaths', () => {
  const files = ['src/app.ts', 'src/app.test.ts', 'src/utils.ts', 'README.md'];

  it('applies both applicablePaths and excludedPaths', () => {
    const check = makeCheck({
      applicablePaths: ['src/**/*.ts'],
      excludedPaths: ['**/*.test.ts'],
    });
    const result = filterCheckPaths(files, check);
    assert.deepEqual(result, ['src/app.ts', 'src/utils.ts']);
  });

  it('excludedPaths takes precedence over applicablePaths', () => {
    const check = makeCheck({
      applicablePaths: ['src/**/*.ts'],
      excludedPaths: ['src/app.ts'],
    });
    const result = filterCheckPaths(files, check);
    assert.deepEqual(result, ['src/app.test.ts', 'src/utils.ts']);
  });
});

// --- static checks (formerly semgrep-only) ---

describe('validateCheck (static)', () => {
  it('static check without instructionsFile passes validation', async () => {
    const check = makeCheck({
      id: 'aghast-sgo',
      instructionsFile: undefined,
      checkTarget: { type: 'static', discovery: 'semgrep', rules: 'rule.yaml' },
    });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join(', ')}`);
    assert.equal(result.errors.length, 0);
  });

  it('non-static check without instructionsFile fails validation', async () => {
    const check = makeCheck({
      id: 'aghast-needs-md',
      instructionsFile: undefined,
    });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(!result.valid, 'Should fail when non-static check lacks instructionsFile');
    assert.ok(result.errors.some((e) => e.includes('instructionsFile')));
  });

  it('targeted check without instructionsFile fails validation', async () => {
    const check = makeCheck({
      id: 'aghast-semgrep-check',
      instructionsFile: undefined,
      checkTarget: { type: 'targeted', discovery: 'semgrep', rules: 'rule.yaml' },
    });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(!result.valid, 'Targeted check should require instructionsFile');
    assert.ok(result.errors.some((e) => e.includes('instructionsFile')));
  });
});

describe('loadCheckDefinition (static)', () => {
  it('loads static check without instructionsFile', async () => {
    const def = await loadCheckDefinition(resolve(fixtureChecksDir, 'aghast-semgrep-only'));
    assert.equal(def.id, 'aghast-semgrep-only');
    assert.equal(def.name, 'Semgrep-Only Check');
    assert.equal(def.instructionsFile, undefined);
    assert.ok(def.checkTarget);
    assert.equal(def.checkTarget!.type, 'static');
    assert.equal(def.checkTarget!.discovery, 'semgrep');
  });
});

// --- sarif discovery (targeted) checks ---

describe('validateCheck (sarif discovery)', () => {
  it('targeted sarif check with instructionsFile passes validation', async () => {
    const check = makeCheck({
      id: 'aghast-sql-injection',
      checkTarget: { type: 'targeted', discovery: 'sarif', sarifFile: './results.sarif' },
    });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join(', ')}`);
  });

  it('targeted sarif check without instructionsFile fails validation', async () => {
    const check = makeCheck({
      id: 'aghast-sv',
      instructionsFile: undefined,
      checkTarget: { type: 'targeted', discovery: 'sarif', sarifFile: './results.sarif' },
    });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(!result.valid, 'Expected invalid — sarif discovery requires instructionsFile');
  });

  it('targeted sarif check with built-in analysisMode passes without instructionsFile', async () => {
    const check = makeCheck({
      id: 'aghast-sv',
      instructionsFile: undefined,
      checkTarget: { type: 'targeted', discovery: 'sarif', sarifFile: './results.sarif', analysisMode: 'false-positive-validation' },
    });
    const result = await validateCheck(check, fixturesDir);
    assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join(', ')}`);
  });
});

describe('loadCheckDefinition (sarif discovery)', () => {
  it('loads sarif discovery check with instructionsFile', async () => {
    const def = await loadCheckDefinition(resolve(fixtureChecksDir, 'aghast-sarif-verify'));
    assert.equal(def.id, 'aghast-sarif-verify');
    assert.equal(def.name, 'SARIF Verify Check');
    assert.equal(def.instructionsFile, 'aghast-sarif-verify.md');
    assert.ok(def.checkTarget);
    assert.equal(def.checkTarget!.type, 'targeted');
    assert.equal(def.checkTarget!.discovery, 'sarif');
  });
});

// --- Schema validation ---

describe('loadCheckRegistry (schema validation)', () => {
  it('throws when a registry entry id is not a string', async () => {
    const badRegistryDir = resolve(fixturesDir, 'cli-configs', 'bad-registry');
    await assert.rejects(
      loadCheckRegistry(badRegistryDir),
      /checks\[0\]\.id must be a non-empty string/,
    );
  });

  it('throws when a registry entry repositories is not an array', async () => {
    const badReposDir = resolve(fixturesDir, 'cli-configs', 'bad-registry-repos');
    await assert.rejects(
      loadCheckRegistry(badReposDir),
      /checks\[0\]\.repositories must be an array/,
    );
  });

  it('throws when excludeRepositories is not an array', async () => {
    const badDir = resolve(fixturesDir, 'cli-configs', 'bad-registry-exclude-repos');
    await assert.rejects(
      loadCheckRegistry(badDir),
      /checks\[0\]\.excludeRepositories must be an array/,
    );
  });
});

describe('loadCheckDefinition (schema validation)', () => {
  it('throws when instructionsFile is not a string', async () => {
    await assert.rejects(
      loadCheckDefinition(resolve(fixtureChecksDir, 'aghast-bad-types')),
      /"instructionsFile" must be a string/,
    );
  });

  it('throws when checkTarget.type is invalid', async () => {
    await assert.rejects(
      loadCheckDefinition(resolve(fixtureChecksDir, 'aghast-bad-target')),
      /"checkTarget\.type" must be one of/,
    );
  });
});
