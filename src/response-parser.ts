/**
 * Response parser.
 * Parses the raw text body of an agent provider's response into
 * CheckResponse format (spec Appendix A.3b). Handles malformed JSON,
 * missing fields, and edge cases.
 */

import type { CheckResponse, AIIssue, DataFlowStep } from './types.js';
import { logDebug } from './logging.js';

const TAG = 'parser';

/**
 * Attempt to parse the raw text body of an agent provider's response
 * into a CheckResponse. Returns undefined if the response is not valid
 * JSON or lacks the expected structure.
 */
export function parseAgentResponse(raw: string): CheckResponse | undefined {
  logDebug(TAG, `Parsing response: ${raw.length} chars`);

  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  // 1) Direct parse
  let parsed: unknown = tryParse(raw);

  // 2) If that fails, look for a fenced code block (```json ... ```)
  if (parsed === undefined) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      logDebug(TAG, 'Trying fenced code block extraction');
      parsed = tryParse(fence[1]);
    }
  }

  // 3) If still failing, grab the first balanced-looking JSON object
  if (parsed === undefined) {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      logDebug(TAG, 'Trying brace extraction');
      const slice = raw.slice(firstBrace, lastBrace + 1);
      parsed = tryParse(slice);
    }
  }

  if (parsed === undefined) {
    logDebug(TAG, 'All parse strategies failed');
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.issues)) {
    logDebug(TAG, `Missing issues array, keys: ${Object.keys(obj).join(', ')}`);
    return undefined;
  }

  const issues: AIIssue[] = [];
  for (const item of obj.issues) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const issue = item as Record<string, unknown>;
    // Required fields: file, description, startLine, endLine (per spec A.3)
    if (typeof issue.file !== 'string' || typeof issue.description !== 'string') {
      continue;
    }
    // Line numbers are required - skip issues without valid line numbers
    if (typeof issue.startLine !== 'number' || typeof issue.endLine !== 'number') {
      logDebug(TAG, `Skipping issue missing required line numbers: ${issue.file}`);
      continue;
    }
    const aiIssue: AIIssue = {
      file: issue.file,
      startLine: issue.startLine,
      endLine: issue.endLine,
      description: issue.description,
    };

    // Parse optional dataFlow array
    if (Array.isArray(issue.dataFlow)) {
      const validSteps: DataFlowStep[] = [];
      for (const step of issue.dataFlow) {
        if (
          typeof step === 'object' && step !== null &&
          typeof (step as Record<string, unknown>).file === 'string' &&
          typeof (step as Record<string, unknown>).lineNumber === 'number' &&
          typeof (step as Record<string, unknown>).label === 'string'
        ) {
          validSteps.push({
            file: (step as Record<string, unknown>).file as string,
            lineNumber: (step as Record<string, unknown>).lineNumber as number,
            label: (step as Record<string, unknown>).label as string,
          });
        }
      }
      if (validSteps.length > 0) {
        aiIssue.dataFlow = validSteps;
      }
    }

    issues.push(aiIssue);
  }

  logDebug(TAG, `Parsed ${issues.length} issues`);

  const response: CheckResponse = { issues };

  if (obj.flagged === true) {
    response.flagged = true;
  }
  if (typeof obj.summary === 'string') {
    response.summary = obj.summary;
  }
  if (typeof obj.analysisNotes === 'string') {
    response.analysisNotes = obj.analysisNotes;
  }
  if (obj.verdict === 'true-positive' || obj.verdict === 'false-positive') {
    response.verdict = obj.verdict;
  }
  if (typeof obj.rationale === 'string') {
    response.rationale = obj.rationale;
  }

  return response;
}
