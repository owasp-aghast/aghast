/**
 * Core type definitions for aghast.
 * Based on SPECIFICATION.md Appendix A.
 */

// --- Default Model ---

export const DEFAULT_MODEL = 'haiku';
export const MOCK_MODEL_NAME = 'mock';

// --- Token Usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** OpenCode-only; billed at output rate by the calculator fallback. */
  reasoningTokens?: number;
  totalTokens: number;
  reportedCost?: {
    amountUsd: number;
    source: 'claude-agent-sdk' | 'opencode';
    /**
     * true when AGHAST_LOCAL_CLAUDE=true — user didn't pay this amount via API.
     * Populated exclusively by ClaudeCodeProvider; other providers should leave it absent.
     */
    coveredBySubscription?: boolean;
  };
}

// --- A.1a Check Registry Entry (Layer 1) ---

export interface CheckRegistryEntry {
  id: string;
  repositories: string[];
  excludeRepositories?: string[];
  enabled?: boolean;
}

// --- A.1b Check Definition (Layer 2) ---

export interface CheckDefinition {
  id: string;
  name: string;
  instructionsFile?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  confidence?: 'high' | 'medium' | 'low';
  model?: string;
  checkTarget?: CheckTargetDefinition;
  applicablePaths?: string[];
  excludedPaths?: string[];
}

// --- A.1 Security Check (merged from Layer 1 + Layer 2) ---

export interface SecurityCheck {
  id: string;
  name: string;
  repositories: string[];
  excludeRepositories?: string[];
  checkTarget?: CheckTargetDefinition;
  instructionsFile?: string;
  applicablePaths?: string[];
  excludedPaths?: string[];
  enabled?: boolean;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  confidence?: 'high' | 'medium' | 'low';
  /** AI model override for this specific check. */
  model?: string;
  /** Path to the check folder (set during resolution). */
  checkDir?: string;
}

// --- A.2 Check Target Definition ---

export interface OpenAntFilterConfig {
  unitTypes?: string[];
  excludeUnitTypes?: string[];
  securityClassifications?: string[];
  reachableOnly?: boolean;
  entryPointsOnly?: boolean;
  minConfidence?: number;
}

export interface CheckTargetDefinition {
  type: 'targeted' | 'static' | 'repository';
  discovery?: 'semgrep' | 'opengrep' | 'openant' | 'sarif';
  rules?: string | string[];
  config?: string;
  sarifFile?: string;
  maxTargets?: number;
  concurrency?: number;
  /** Cap on issues returned per target; omit for unlimited. See docs/configuration.md. */
  maxIssuesPerTarget?: number;
  /** Analysis mode: determines the AI's approach to each target. */
  analysisMode?: 'custom' | 'false-positive-validation' | 'general-vuln-discovery';
  openant?: OpenAntFilterConfig;
  /**
   * Opt-out for post-discovery diff filtering. Set to `false` to skip the
   * filter for this check even when a diff source is available at scan time.
   * When unset (or `true`), filtering is applied automatically whenever a
   * diff source is present and the discovery supports diff filtering.
   */
  diffFilter?: boolean;
  /**
   * Git ref to diff against for this check (e.g. 'main', 'HEAD~1').
   *
   * Overridden by any runtime diff source. Precedence, highest to lowest:
   *   1. CLI `--diff-file <path>` (CLI only; no AGHAST_DIFF_FILE env var
   *      equivalent) — when present, bypasses all ref sources including
   *      this field; the file is used directly.
   *   2. CLI `--diff-ref <ref>`
   *   3. `AGHAST_DIFF_REF` env var
   *   4. Runtime config `diffRef`
   *   5. This field (check-level fallback).
   */
  diffRef?: string;
}

// --- A.2b Check Target (discovered location) ---

export interface CheckTarget {
  file: string;
  startLine: number;
  endLine: number;
  message: string;
  snippet?: string;
}

// --- A.3 Data Flow Step ---

export interface DataFlowStep {
  file: string;
  lineNumber: number;
  label: string;
}

// --- A.3 Security Issue ---

export interface SecurityIssue {
  checkId: string;
  checkName: string;
  file: string;
  startLine: number; // Required - AI must always provide line numbers
  endLine: number; // Required - AI must always provide line numbers
  description: string;
  codeSnippet?: string;
  severity?: string;
  confidence?: string;
  recommendation?: string;
  dataFlow?: DataFlowStep[];
}

// --- A.3b Check Response ---

export interface CheckResponse {
  issues: AIIssue[];
  flagged?: boolean;
  summary?: string;
  analysisNotes?: string;
  /**
   * Validation verdict for false-positive-validation mode. Set by the AI when
   * validating an externally reported finding. When absent, the verdict is
   * inferred from whether any issues were returned.
   */
  verdict?: 'true-positive' | 'false-positive';
  /**
   * Human-readable rationale for the verdict — especially valuable for false
   * positives, which would otherwise produce no output at all.
   */
  rationale?: string;
}

// --- Validation Record (false-positive-validation mode) ---

/**
 * The outcome of validating a single externally reported finding in
 * false-positive-validation mode. Captures the verdict and rationale for both
 * confirmed (true-positive) and dismissed (false-positive) findings, so the
 * dismissals are retained rather than silently dropped.
 */
export interface ValidationRecord {
  checkId: string;
  checkName: string;
  verdict: 'true-positive' | 'false-positive';
  /** The externally reported finding that was validated. */
  target: CheckTarget;
  /** Why the AI reached this verdict. */
  rationale: string;
  /**
   * For true-positive verdicts, the index into ScanResults.issues of the
   * first confirmed issue for this target. A single target may map to multiple
   * confirmed issues, which are stored consecutively starting at this index;
   * the count is not tracked, so consumers needing every linked issue should
   * match on the target rather than assuming a one-to-one mapping. Omitted for
   * false positives.
   */
  issueIndex?: number;
}

/** Raw issue as returned by the AI (before enrichment). */
export interface AIIssue {
  file: string;
  startLine: number; // Required - enforced via JSON schema in agent provider
  endLine: number; // Required - enforced via JSON schema in agent provider
  description: string;
  dataFlow?: DataFlowStep[];
}

// --- A.4 Check Execution Summary ---

export interface CheckExecutionSummary {
  checkId: string;
  checkName: string;
  status: 'PASS' | 'FAIL' | 'FLAG' | 'ERROR';
  issuesFound: number;
  executionTime: number;
  targetsAnalyzed?: number;
  error?: string;
  /**
   * Raw text body of the agent provider's response, included in ERROR results
   * for debugging. Field name retains "AI" (rather than "Agent") because the
   * stored content is the LLM's raw text output — same rationale as
   * AGHAST_MOCK_AI / AGHAST_AI_MODEL: the model and its output are AI/LLM
   * concerns, the harness around them is the agent.
   */
  rawAiResponse?: string;
  tokenUsage?: TokenUsage;
  /**
   * Count of validation verdicts for false-positive-validation checks.
   * Present only when the check ran in that mode.
   */
  validationsCount?: { truePositive: number; falsePositive: number };
}

// --- A.5a CI/CD Metadata (spec E.4) ---

/**
 * CI/CD pipeline context captured during a scan run. Populated automatically
 * from environment variables when aghast detects it is running inside a
 * supported CI/CD platform (GitHub Actions, GitLab CI, CircleCI). All fields
 * are optional in case detection is partial.
 */
export interface CIMetadata {
  /** URL of the CI/CD job that produced this scan. */
  jobUrl?: string;
  /**
   * Ref that was scanned. On GitHub Actions this is `GITHUB_REF_NAME` —
   * a branch name on `push` to a branch, the tag name on a tag push, or
   * the PR merge ref (e.g. `123/merge`) on `pull_request` events. Consult
   * `pipelineSource` to disambiguate.
   */
  branch?: string;
  /**
   * Platform-specific trigger string verbatim. Vocabularies differ:
   * GitHub Actions emits `push`, `pull_request`, `schedule`, `workflow_dispatch`,
   * `repository_dispatch`, etc.; GitLab CI emits `push`, `merge_request_event`,
   * `schedule`, `web`, `api`, `external`, etc.; CircleCI does not set this
   * field. Consumers should treat the value as an opaque string and not
   * assume a unified vocabulary across platforms.
   */
  pipelineSource?: string;
  /** ISO-8601 timestamp for when the CI/CD job started. */
  jobStartedAt?: string;
}

// --- A.5 Complete Scan Results ---

export interface ScanResults {
  scanId: string;
  timestamp: string;
  version: string;
  repository: RepositoryInfo;
  issues: SecurityIssue[];
  /**
   * Validation records from false-positive-validation checks (both confirmed
   * and dismissed findings). Present only when at least one such check ran.
   */
  validations?: ValidationRecord[];
  checks: CheckExecutionSummary[];
  summary: ScanSummary;
  executionTime: number;
  startTime: string;
  endTime: string;
  agentProvider: {
    name: string;
    models: string[];
  };
  tokenUsage?: TokenUsage;
  metadata?: ScanMetadata;
}

/**
 * Additional metadata about the scan environment. Currently carries CI/CD
 * pipeline context (spec E.4) when running in a supported CI environment.
 * Extend by adding explicit fields here when new metadata is introduced —
 * keeping the type closed surfaces typos at compile time.
 */
export interface ScanMetadata {
  ciMetadata?: CIMetadata;
  /**
   * Cost summary, attached by `runMultiScan` when pricing config is available.
   * See `src/cost-calculator.ts`.
   */
  cost?: {
    totalCostUsd: number;
    currency: string;
  };
}

export interface RepositoryInfo {
  path: string;
  remoteUrl?: string;
  branch?: string;
  commit?: string;
  isGitRepository: boolean;
}

export interface ScanSummary {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  flaggedChecks: number;
  errorChecks: number;
  totalIssues: number;
}

// --- Runtime Configuration (spec Section 8.1) ---

export interface RuntimeBudgetConfig {
  perScan?: {
    maxTokens?: number;
    maxCostUsd?: number;
  };
  perPeriod?: {
    window?: 'day' | 'week' | 'month';
    maxCostUsd?: number;
  };
  thresholds?: {
    warnAt?: number;
    abortAt?: number;
  };
}

export interface RuntimePricingConfig {
  currency?: string;
  models?: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number; cacheWritePerMillion?: number }>;
}

export interface RuntimeConfig {
  agentProvider?: {
    name?: string;
    model?: string;
  };
  reporting?: {
    outputDirectory?: string;
    outputFormat?: string;
    /** When true, write a separate file per issue alongside the main report. */
    includeIndividualIssueFiles?: boolean;
    /** Format used when `includeIndividualIssueFiles` is true. Default: `markdown`. */
    individualIssueFormat?: 'markdown' | 'json' | 'html';
  };
  logging?: {
    logFile?: string;
    logType?: string;
    level?: string;
  };
  genericPrompt?: string;
  failOnCheckFailure?: boolean;
  /**
   * Git ref to diff against. Auto-activates diff filtering on every check
   * whose discovery supports it, unless the check opts out via diffFilter: false.
   */
  diffRef?: string;
  budget?: RuntimeBudgetConfig;
  pricing?: RuntimePricingConfig;
}

// --- A.6 Aggregated Report ---

export interface AggregatedReport {
  timestamp: string;
  projectsScanned: number;
  repositories: string[];
  issues: AggregatedIssue[];
  checks: AggregatedCheckSummary[];
  projectSummaries: ProjectSummary[];
  summary: ScanSummary;
}

export interface AggregatedIssue extends SecurityIssue {
  projectName: string;
  repositoryUrl?: string;
}

export interface AggregatedCheckSummary extends CheckExecutionSummary {
  projectName: string;
  timestamp: string;
  jobUrl?: string;
  branch?: string;
  pipelineSource?: string;
}

export interface ProjectSummary {
  projectName: string;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  errorChecks: number;
  issuesFound: number;
  timestamp: string;
  jobUrl?: string;
  branch?: string;
  pipelineSource?: string;
}

// --- A.7 Check Details ---

export interface CheckDetails {
  id: string;
  name: string;
  overview: string;
  content: string;
}

// --- C.5 Agent Provider Interface ---

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  [key: string]: unknown;
}

export interface AgentResponse {
  raw: string;
  parsed?: CheckResponse;
  tokenUsage?: TokenUsage;
}

/** Describes a single model exposed by a provider's `listModels()`. */
export interface ProviderModelInfo {
  /** Model identifier as accepted by the provider (stored in runtime config). */
  id: string;
  /** Optional human-readable label shown in selection UIs. */
  label?: string;
  /** Optional one-line description shown in selection UIs. */
  description?: string;
}

export interface AgentProvider {
  initialize(config: ProviderConfig): Promise<void>;
  executeCheck(
    instructions: string,
    repositoryPath: string,
    logPrefix?: string,
    options?: { maxTurns?: number },
  ): Promise<AgentResponse>;
  validateConfig(): Promise<boolean>;
  /**
   * Check that required prerequisites (API keys, binaries, etc.) are available.
   * Called before initialize() to give early feedback. Throws with a descriptive
   * error message if a prerequisite is missing. May be async (e.g. the Claude Code
   * provider probes local login status when no API key is set).
   */
  checkPrerequisites?(): void | Promise<void>;
  /**
   * Whether the provider resolved to local (subscription-covered) authentication rather
   * than an API key. Used to label cost/budget output. Returns undefined-equivalent when
   * the provider has no concept of local mode (callers fall back to env detection).
   */
  isLocalMode?(): boolean;
  getModelName?(): string;
  setModel?(model: string): void;
  cleanup?(): Promise<void>;
  /** Closed list of models this provider accepts. Used by `aghast build-config`. */
  listModels?(): Promise<readonly ProviderModelInfo[]>;
}

/**
 * Error thrown by agent providers for unrecoverable failures (e.g. 401 auth, rate limits).
 * When caught by the scan runner, this signals that the entire scan should abort —
 * no further checks or targets should be attempted.
 */
export class FatalProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalProviderError';
  }
}
