/**
 * CI/CD pipeline metadata detection (spec E.4).
 *
 * Detects whether aghast is running inside a known CI/CD platform and
 * collects pipeline context (job URL, branch, trigger, start time) from
 * platform-specific environment variables.
 *
 * Supported platforms: GitHub Actions, GitLab CI, CircleCI. Extending to
 * new platforms means adding another collector function below.
 *
 * The functions only read from a supplied env object (defaulting to
 * `process.env`); they never mutate it and never throw.
 */

import type { CIMetadata } from './types.js';

/** Read-only env shape (process.env compatible). */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Every CI/CD environment variable this module consults. Exported so test
 * helpers can scrub these vars in one place and stay in sync with this
 * module — adding a new var here automatically updates the hermetic test
 * scrub list.
 */
export const CI_ENV_VAR_NAMES: readonly string[] = [
  // Generic
  'CI',
  // GitHub Actions
  'GITHUB_ACTIONS',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_REF_NAME',
  'GITHUB_EVENT_NAME',
  'GITHUB_RUN_STARTED_AT',
  // GitLab CI
  'GITLAB_CI',
  'CI_JOB_URL',
  'CI_COMMIT_REF_NAME',
  'CI_PIPELINE_SOURCE',
  'CI_JOB_STARTED_AT',
  // CircleCI
  'CIRCLECI',
  'CIRCLE_BUILD_URL',
  'CIRCLE_BRANCH',
];

/** Returns true when the env var holds a recognised truthy CI flag value. */
function isTrueFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * Returns true when aghast appears to be running inside a CI/CD environment.
 *
 * Most CI providers set `CI=true`; we also accept platform-specific signals
 * (`GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`) to cover edge cases where the
 * generic `CI` flag is unset but the platform-specific flag is present. All
 * flags accept the literal strings `'true'` or `'1'` for parity.
 */
export function detectCI(env: EnvLike = process.env): boolean {
  return (
    isTrueFlag(env.CI) ||
    isTrueFlag(env.GITHUB_ACTIONS) ||
    isTrueFlag(env.GITLAB_CI) ||
    isTrueFlag(env.CIRCLECI)
  );
}

/**
 * Collect CI/CD metadata from the environment. Returns `undefined` when no
 * CI signals are present, or when no platform-specific fields could be
 * resolved (i.e. nothing useful to report).
 *
 * Platform precedence: GitHub Actions → GitLab CI → CircleCI. If multiple
 * sets of variables somehow coexist, the first matched platform wins.
 */
export function collectCIMetadata(env: EnvLike = process.env): CIMetadata | undefined {
  if (!detectCI(env)) return undefined;

  const collectors: Array<(env: EnvLike) => CIMetadata | undefined> = [
    collectGitHubActions,
    collectGitLabCI,
    collectCircleCI,
  ];
  for (const collect of collectors) {
    const meta = collect(env);
    if (meta && hasAnyField(meta)) return meta;
  }
  return undefined;
}

function hasAnyField(meta: CIMetadata): boolean {
  return Boolean(meta.jobUrl ?? meta.branch ?? meta.pipelineSource ?? meta.jobStartedAt);
}

/** GitHub Actions: builds job URL from server/repo/run-id; reads ref + event + start time. */
function collectGitHubActions(env: EnvLike): CIMetadata | undefined {
  if (!isTrueFlag(env.GITHUB_ACTIONS)) return undefined;
  const meta: CIMetadata = {};
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (server && repo && runId) {
    meta.jobUrl = `${server}/${repo}/actions/runs/${runId}`;
  }
  if (env.GITHUB_REF_NAME) meta.branch = env.GITHUB_REF_NAME;
  if (env.GITHUB_EVENT_NAME) meta.pipelineSource = env.GITHUB_EVENT_NAME;
  if (env.GITHUB_RUN_STARTED_AT) meta.jobStartedAt = env.GITHUB_RUN_STARTED_AT;
  return meta;
}

/** GitLab CI: native fields cover all four metadata slots directly. */
function collectGitLabCI(env: EnvLike): CIMetadata | undefined {
  if (!isTrueFlag(env.GITLAB_CI)) return undefined;
  const meta: CIMetadata = {};
  if (env.CI_JOB_URL) meta.jobUrl = env.CI_JOB_URL;
  if (env.CI_COMMIT_REF_NAME) meta.branch = env.CI_COMMIT_REF_NAME;
  if (env.CI_PIPELINE_SOURCE) meta.pipelineSource = env.CI_PIPELINE_SOURCE;
  if (env.CI_JOB_STARTED_AT) meta.jobStartedAt = env.CI_JOB_STARTED_AT;
  return meta;
}

/** CircleCI: only job URL + branch are exposed; trigger/start time are not standard. */
function collectCircleCI(env: EnvLike): CIMetadata | undefined {
  if (!isTrueFlag(env.CIRCLECI)) return undefined;
  const meta: CIMetadata = {};
  if (env.CIRCLE_BUILD_URL) meta.jobUrl = env.CIRCLE_BUILD_URL;
  if (env.CIRCLE_BRANCH) meta.branch = env.CIRCLE_BRANCH;
  return meta;
}
