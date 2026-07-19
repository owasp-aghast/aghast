/**
 * Unit tests for CI/CD metadata detection (src/ci-metadata.ts, spec E.4).
 *
 * Each test passes a synthetic env object so process.env stays untouched.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectCIMetadata, detectCI } from '../src/ci-metadata.js';

describe('detectCI', () => {
  it('returns false on an empty env', () => {
    assert.equal(detectCI({}), false);
  });

  it('returns true when CI=true', () => {
    assert.equal(detectCI({ CI: 'true' }), true);
  });

  it('returns true when CI=1', () => {
    assert.equal(detectCI({ CI: '1' }), true);
  });

  it('returns false when CI is set to a falsy-ish value', () => {
    assert.equal(detectCI({ CI: 'false' }), false);
    assert.equal(detectCI({ CI: '' }), false);
  });

  it('returns true when GITHUB_ACTIONS=true even without CI', () => {
    assert.equal(detectCI({ GITHUB_ACTIONS: 'true' }), true);
  });

  it('returns true when GITLAB_CI=true even without CI', () => {
    assert.equal(detectCI({ GITLAB_CI: 'true' }), true);
  });

  it('returns true when CIRCLECI=true even without CI', () => {
    assert.equal(detectCI({ CIRCLECI: 'true' }), true);
  });
});

describe('collectCIMetadata', () => {
  it('returns undefined outside CI', () => {
    assert.equal(collectCIMetadata({}), undefined);
  });

  it('returns undefined when CI=true but no platform-specific signals exist', () => {
    // detectCI returns true (CI=true), but no per-platform collector matches,
    // so there's nothing useful to report.
    assert.equal(collectCIMetadata({ CI: 'true' }), undefined);
  });

  it('maps GitHub Actions env vars correctly', () => {
    const meta = collectCIMetadata({
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'org/repo',
      GITHUB_RUN_ID: '12345',
      GITHUB_REF_NAME: 'feature/auth-fix',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_RUN_STARTED_AT: '2026-01-18T10:00:00Z',
    });
    assert.deepEqual(meta, {
      jobUrl: 'https://github.com/org/repo/actions/runs/12345',
      branch: 'feature/auth-fix',
      pipelineSource: 'push',
      jobStartedAt: '2026-01-18T10:00:00Z',
    });
  });

  it('handles partial GitHub Actions env (missing run-id leaves jobUrl unset)', () => {
    const meta = collectCIMetadata({
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'org/repo',
      // no GITHUB_RUN_ID
      GITHUB_REF_NAME: 'main',
    });
    assert.ok(meta);
    assert.equal(meta.jobUrl, undefined);
    assert.equal(meta.branch, 'main');
  });

  it('maps GitLab CI env vars correctly', () => {
    const meta = collectCIMetadata({
      CI: 'true',
      GITLAB_CI: 'true',
      CI_JOB_URL: 'https://gitlab.com/org/repo/-/jobs/789',
      CI_COMMIT_REF_NAME: 'develop',
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_JOB_STARTED_AT: '2026-02-03T08:30:00Z',
    });
    assert.deepEqual(meta, {
      jobUrl: 'https://gitlab.com/org/repo/-/jobs/789',
      branch: 'develop',
      pipelineSource: 'merge_request_event',
      jobStartedAt: '2026-02-03T08:30:00Z',
    });
  });

  it('maps CircleCI env vars correctly (only jobUrl + branch)', () => {
    const meta = collectCIMetadata({
      CI: 'true',
      CIRCLECI: 'true',
      CIRCLE_BUILD_URL: 'https://circleci.com/gh/org/repo/42',
      CIRCLE_BRANCH: 'main',
    });
    assert.deepEqual(meta, {
      jobUrl: 'https://circleci.com/gh/org/repo/42',
      branch: 'main',
    });
  });

  it('GitHub Actions takes precedence when multiple platform flags coexist', () => {
    const meta = collectCIMetadata({
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'org/repo',
      GITHUB_RUN_ID: '1',
      GITHUB_REF_NAME: 'gh-branch',
      GITHUB_EVENT_NAME: 'push',
      GITLAB_CI: 'true',
      CI_JOB_URL: 'https://gitlab.com/org/repo/-/jobs/789',
      CI_COMMIT_REF_NAME: 'gl-branch',
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CIRCLECI: 'true',
      CIRCLE_BUILD_URL: 'https://circleci.com/gh/org/repo/42',
      CIRCLE_BRANCH: 'cc-branch',
    });
    // Returned object should be exactly the GitHub Actions collector's
    // output — no fields from GitLab or CircleCI should leak in.
    assert.deepEqual(meta, {
      jobUrl: 'https://github.com/org/repo/actions/runs/1',
      branch: 'gh-branch',
      pipelineSource: 'push',
    });
  });

  it('GitLab CI takes precedence over CircleCI when both flags coexist', () => {
    const meta = collectCIMetadata({
      CI: 'true',
      GITLAB_CI: 'true',
      CI_JOB_URL: 'https://gitlab.com/org/repo/-/jobs/789',
      CI_COMMIT_REF_NAME: 'gl-branch',
      CIRCLECI: 'true',
      CIRCLE_BUILD_URL: 'https://circleci.com/gh/org/repo/42',
      CIRCLE_BRANCH: 'cc-branch',
    });
    assert.deepEqual(meta, {
      jobUrl: 'https://gitlab.com/org/repo/-/jobs/789',
      branch: 'gl-branch',
    });
  });

  it('accepts platform flag value "1" as truthy (parity with CI)', () => {
    // Defensive: cover the case where someone exports e.g. GITHUB_ACTIONS=1
    // for local debugging or a non-standard runner emits "1" rather than "true".
    assert.equal(detectCI({ GITHUB_ACTIONS: '1' }), true);
    assert.equal(detectCI({ GITLAB_CI: '1' }), true);
    assert.equal(detectCI({ CIRCLECI: '1' }), true);
    const meta = collectCIMetadata({
      GITHUB_ACTIONS: '1',
      GITHUB_REF_NAME: 'main',
    });
    assert.equal(meta?.branch, 'main');
  });

  it('does not mutate the supplied env object', () => {
    const env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'main' };
    const snapshot = { ...env };
    collectCIMetadata(env);
    assert.deepEqual(env, snapshot);
  });

  it('returns undefined when GitHub Actions flag is set but no fields are populated', () => {
    // Only the platform flag is set; no useful metadata fields. Should return
    // undefined rather than an empty CIMetadata object.
    const meta = collectCIMetadata({ GITHUB_ACTIONS: 'true' });
    assert.equal(meta, undefined);
  });
});
