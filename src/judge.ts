/**
 * LLM judge stage: re-evaluates aggregated SecurityIssues after all checks have run.
 * Annotates each issue with a verdict (true_positive / false_positive / uncertain),
 * confidence, and rationale. Runs as a separate pipeline stage in runMultiScanWithCost.
 */

import { logProgress, logDebug, logWarn, createTimer } from './logging.js';
import { type AgentProvider, type AgentResponse, type SecurityIssue, type JudgeVerdict } from './types.js';
import { withRetry, defaultIsRetryable, DEFAULT_RETRY, AgentTimeoutError, type RetryOptions, type CircuitBreaker } from './retry.js';
import { BudgetExceededError } from './budget.js';
import { type ScanCostTracker, preflightBudget, recordUsage } from './cost-tracker.js';
import { type AbortHandle, mapWithConcurrency } from './concurrency.js';

const TAG = 'judge';
const DEFAULT_JUDGE_CONCURRENCY = 5;
const DEFAULT_JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Thrown by the internal timeout race when a judge provider call exceeds
 * DEFAULT_JUDGE_TIMEOUT_MS. Module-private: callers distinguish it via
 * `instanceof JudgeTimeoutError` inside this module only.
 */
class JudgeTimeoutError extends AgentTimeoutError {
  constructor(timeoutSeconds: number) {
    super(`Judge provider timed out after ${timeoutSeconds}s`);
    // Deliberately does NOT override `name`: the retry classifier matches on
    // `AgentTimeoutError` by name (so it survives a serialization boundary),
    // and callers in this module distinguish it with `instanceof` anyway.
  }
}

export interface JudgeOptions {
  provider: AgentProvider;
  providerName: string;
  model: string;
  concurrency?: number;
  dropFalsePositives?: boolean;
  minConfidence?: number;
  /**
   * Retry settings for the judge's own AI calls. The scan runner passes the
   * same resolved options it uses for check analysis, so opting into retry
   * covers judging too. Omitted means the caller did not opt in, and
   * `DEFAULT_RETRY` (one attempt) applies.
   */
  retry?: RetryOptions;
  /** Circuit breaker shared with the scan, when retry is enabled. */
  breaker?: CircuitBreaker;
}

/** Map from check ID to the check's markdown instructions (used in judge prompt). */
export type CheckInstructionsMap = Map<string, string>;

/**
 * Parse a raw judge response into a JudgeVerdict.
 * Returns undefined if the response is not parseable or lacks required fields.
 */
export function parseJudgeResponse(raw: string): Pick<JudgeVerdict, 'verdict' | 'confidence' | 'rationale'> | undefined {
  const tryParse = (text: string): unknown => {
    try { return JSON.parse(text); } catch { return undefined; }
  };

  let parsed: unknown = tryParse(raw);
  if (parsed === undefined) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) parsed = tryParse(fence[1]);
  }
  if (parsed === undefined) {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      parsed = tryParse(raw.slice(firstBrace, lastBrace + 1));
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  const validVerdicts = ['true_positive', 'false_positive', 'uncertain'];
  if (typeof obj.verdict !== 'string' || !validVerdicts.includes(obj.verdict)) return undefined;
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) return undefined;
  if (typeof obj.rationale !== 'string') return undefined;

  return {
    verdict: obj.verdict as JudgeVerdict['verdict'],
    confidence: obj.confidence,
    rationale: obj.rationale,
  };
}

/** Build the judge prompt for a single issue. */
function buildJudgePrompt(issue: SecurityIssue, checkInstructions: string | undefined): string {
  const lines: string[] = [];
  lines.push('You are a security finding validator. Review the following reported security issue and determine if it is a genuine vulnerability (true positive), a false alarm (false positive), or uncertain.');
  lines.push('');
  lines.push('Respond with JSON only:');
  lines.push('{ "verdict": "true_positive" | "false_positive" | "uncertain", "confidence": <0.0-1.0>, "rationale": "<brief explanation>" }');
  lines.push('');
  lines.push(`## Check: ${issue.checkName}`);

  if (checkInstructions) {
    lines.push('');
    lines.push('### What this check looks for:');
    lines.push(checkInstructions);
  }

  lines.push('');
  lines.push('## Reported Finding');
  lines.push(`File: ${issue.file}`);
  lines.push(`Lines: ${issue.startLine}–${issue.endLine}`);
  lines.push(`Description: ${issue.description}`);

  if (issue.codeSnippet) {
    lines.push('');
    lines.push('### Code snippet:');
    lines.push('```');
    lines.push(issue.codeSnippet);
    lines.push('```');
  }

  if (issue.dataFlow && issue.dataFlow.length > 0) {
    lines.push('');
    lines.push('### Data flow:');
    for (const step of issue.dataFlow) {
      lines.push(`  ${step.file}:${step.lineNumber} — ${step.label}`);
    }
  }

  lines.push('');
  lines.push('Is this a real security issue? Respond with JSON only.');
  return lines.join('\n');
}

/**
 * Run the judge stage over all collected issues.
 * Mutates each issue in place by attaching a `judge` field.
 * Returns the issues array (same reference, mutated).
 */
export async function runJudge(
  issues: SecurityIssue[],
  checksById: Map<string, { check: { judge?: boolean }; instructions: string | undefined }>,
  repositoryPath: string,
  options: JudgeOptions,
  costTracker: ScanCostTracker,
): Promise<SecurityIssue[]> {
  if (issues.length === 0) return issues;

  const effectiveConcurrency = options.concurrency ?? DEFAULT_JUDGE_CONCURRENCY;
  const judgeModel = options.model;

  // Apply per-check model
  options.provider.setModel?.(judgeModel);

  logProgress(TAG, `Judging ${issues.length} issues (model: ${judgeModel}, concurrency: ${effectiveConcurrency})`);
  const judgeTimer = createTimer();

  const abortHandle: AbortHandle = { aborted: false };

  await mapWithConcurrency(
    issues,
    effectiveConcurrency,
    async (issue, _idx) => {
      const checkEntry = checksById.get(issue.checkId);

      // Per-check opt-out: skip if check.judge === false
      if (checkEntry?.check.judge === false) {
        logDebug(TAG, `Skipping issue from check "${issue.checkId}" (judge: false)`);
        return;
      }

      const checkInstructions = checkEntry?.instructions;
      const prompt = buildJudgePrompt(issue, checkInstructions);

      try {
        preflightBudget(costTracker);
      } catch (budgetErr) {
        if (budgetErr instanceof BudgetExceededError) {
          abortHandle.aborted = true;
          abortHandle.reason = budgetErr;
          throw budgetErr;
        }
        throw budgetErr;
      }

      logDebug(TAG, `Judging issue: ${issue.checkId} @ ${issue.file}:${issue.startLine}`);

      try {
        // Declared as a function so each retry gets a fresh timer — reusing a
        // single handle across attempts would leave the first attempt's timeout
        // armed and abort a later, healthy one. Mirrors `analyzeOnce` in the
        // scan runner.
        const judgeOnce = async (): Promise<AgentResponse> => {
          let timeoutHandle: NodeJS.Timeout | undefined;
          return Promise.race([
            options.provider.executeCheck(prompt, repositoryPath, `[judge:${issue.checkId}]`),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new JudgeTimeoutError(DEFAULT_JUDGE_TIMEOUT_MS / 1000)),
                DEFAULT_JUDGE_TIMEOUT_MS,
              );
            }),
          ]).finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          });
        };

        // The judge makes its own AI calls, and they are as prone to transient
        // provider failure as check analysis is. Without this a dropped stream
        // degraded the verdict to `uncertain`, which escalates the check to
        // FLAG — turning a network blip into a flagged security finding.
        const agentResponse = await withRetry(judgeOnce, {
          ...DEFAULT_RETRY,
          ...options.retry,
          breaker: options.breaker,
          label: `judge:${issue.checkId}`,
          // Stop retrying the moment another worker has aborted the run
          // (budget exceeded, or a fatal provider error).
          isRetryable: (err) => !abortHandle.aborted && defaultIsRetryable(err),
        });

        recordUsage(costTracker, agentResponse.tokenUsage, judgeModel);

        const parsed = parseJudgeResponse(agentResponse.raw);
        if (!parsed) {
          logDebug(TAG, `Judge returned malformed response for ${issue.checkId}@${issue.file}:${issue.startLine}`);
          issue.judge = {
            verdict: 'uncertain',
            confidence: 0,
            rationale: 'judge failed: malformed response',
            model: judgeModel,
            provider: options.providerName,
            tokenUsage: agentResponse.tokenUsage,
          };
          return;
        }

        // Apply minConfidence demotion: true_positive below threshold → uncertain
        let { verdict, rationale } = parsed;
        const { confidence } = parsed;
        if (
          verdict === 'true_positive' &&
          options.minConfidence !== undefined &&
          confidence < options.minConfidence
        ) {
          logDebug(TAG, `Demoting true_positive to uncertain (confidence ${confidence} < minConfidence ${options.minConfidence})`);
          verdict = 'uncertain';
          rationale = `${rationale} [demoted: confidence ${confidence.toFixed(2)} < minConfidence ${options.minConfidence}]`;
        }

        issue.judge = {
          verdict,
          confidence,
          rationale,
          model: judgeModel,
          provider: options.providerName,
          tokenUsage: agentResponse.tokenUsage,
        };
        logDebug(TAG, `Judge verdict: ${verdict} (confidence: ${confidence}) for ${issue.checkId}@${issue.file}:${issue.startLine}`);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof JudgeTimeoutError) {
          logWarn(TAG, `Judge timed out for ${issue.checkId}@${issue.file}:${issue.startLine} — token usage for this call was not recorded`);
        }
        logDebug(TAG, `Judge error for ${issue.checkId}: ${errorMsg}`);
        issue.judge = {
          verdict: 'uncertain',
          confidence: 0,
          rationale: `judge failed: ${errorMsg}`,
          model: judgeModel,
          provider: options.providerName,
        };
      }
    },
    abortHandle,
  );

  logProgress(TAG, `Judge stage completed in ${judgeTimer.elapsedStr()}`);
  return issues;
}

/**
 * Recompute per-check statuses and summary counts after the judge stage.
 *
 * Recomputation order (per issue 290 design):
 * 1. Apply minConfidence demotion (already done in runJudge per-issue)
 * 2. Drop false positives if dropFalsePositives is set
 * 3. Escalate checks whose remaining issues are all uncertain → FLAG
 * 4. Set flagSource on issues
 * 5. Recompute summary counts
 *
 * Returns the filtered issues array and updated check summaries.
 */
export function applyJudgeResults(
  allIssues: SecurityIssue[],
  allCheckSummaries: import('./types.js').CheckExecutionSummary[],
  options: Pick<JudgeOptions, 'dropFalsePositives'>,
): {
  filteredIssues: SecurityIssue[];
  judgedIssues: number;
  falsePositives: number;
  uncertainJudgements: number;
} {
  // Count judge verdicts across all judged issues
  let judgedCount = 0;
  let fpCount = 0;
  let uncertainCount = 0;

  // Step 1: Remove confirmed false positives if dropFalsePositives is set
  let filteredIssues = allIssues;
  if (options.dropFalsePositives) {
    filteredIssues = allIssues.filter((issue) => {
      if (!issue.judge) return true; // No verdict: keep
      if (issue.judge.verdict === 'false_positive') return false; // Drop FP
      return true;
    });
  }

  // Count verdicts from allIssues (pre-filter) so that dropped FPs are included
  // in judgedIssues and falsePositives regardless of dropFalsePositives.
  for (const issue of allIssues) {
    if (issue.judge) {
      judgedCount++;
      if (issue.judge.verdict === 'false_positive') fpCount++;
      if (issue.judge.verdict === 'uncertain') uncertainCount++;
    }
  }

  // Step 2: Group remaining issues by checkId
  const issuesByCheck = new Map<string, SecurityIssue[]>();
  for (const issue of filteredIssues) {
    const existing = issuesByCheck.get(issue.checkId);
    if (existing) {
      existing.push(issue);
    } else {
      issuesByCheck.set(issue.checkId, [issue]);
    }
  }

  // Step 3: Recompute per-check status based on remaining issues
  for (const summary of allCheckSummaries) {
    const checkIssues = issuesByCheck.get(summary.checkId) ?? [];

    // Restore any check that was FAIL but lost all its issues to FP drops → PASS
    if (summary.status === 'FAIL' && checkIssues.length === 0 && options.dropFalsePositives) {
      summary.status = 'PASS';
      summary.issuesFound = 0;
    } else if (summary.status === 'FAIL' && checkIssues.length > 0) {
      // Check if all remaining issues are uncertain → escalate to FLAG
      const allUncertain = checkIssues.every(
        (i) => i.judge && i.judge.verdict === 'uncertain',
      );
      if (allUncertain) {
        summary.status = 'FLAG';
        summary.issuesFound = checkIssues.length;
        // Attach flagSource: "judge" to each uncertain issue
        for (const issue of checkIssues) {
          // Decision #9: flagSource:"check" wins if already set
          if (!issue.flagSource) {
            issue.flagSource = 'judge';
          }
        }
      } else {
        summary.issuesFound = checkIssues.length;
      }
    }
  }

  return { filteredIssues, judgedIssues: judgedCount, falsePositives: fpCount, uncertainJudgements: uncertainCount };
}
