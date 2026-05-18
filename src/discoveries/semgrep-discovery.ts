/**
 * Semgrep-based target discovery.
 *
 * Runs Semgrep rules against the repository, parses SARIF output,
 * and returns discovered targets with inline prompt enrichment.
 */

import { runSemgrep } from '../semgrep-runner.js';
import { parseSARIF, deduplicateTargets } from '../sarif-parser.js';
import { logDebug } from '../logging.js';
import { DEFAULT_GENERIC_PROMPT } from '../defaults.js';
import type { TargetDiscovery, DiscoveredTarget, DiscoveryOptions } from '../discovery.js';
import type { SecurityCheck } from '../types.js';

const TAG = 'semgrep-discovery';

function buildTargetPromptEnrichment(file: string, startLine: number, endLine: number): string {
  return `\n\nTARGET LOCATION:

You are analyzing a specific code location:
- File: ${file}
- Lines: ${startLine}-${endLine}

You MUST:
- Analyze ONLY this specific target location — do not search for or report issues at other locations
- You may read other files to understand context (e.g., imports, type definitions, data flow), but only report issues for this target
- If the code at this location is not vulnerable, return {"issues": []} — do not "spend" the target by reporting an issue you noticed somewhere else in the file
- Do NOT scan the broader repository for other instances of this vulnerability pattern

REPORTING RULES (strict — these prevent cross-target hallucinations):
- Each reported issue's "file"/"startLine"/"endLine" MUST point at this target's range above, OR at a line inside a function this target directly/transitively calls. They must NOT point at a sibling location (e.g. another function, another route handler, another class) that simply happens to live in the same file. If that sibling is genuinely vulnerable, it has its own target run — leave it alone here.

DESCRIPTION OPENING (mandatory output contract):
- Your description's first heading MUST identify the entry point this target represents — its function name, route path+verb, class method, or equivalent — exactly as it appears in the source. For example: a route handler → "## Missing X in DELETE /:id"; a function → "## Missing X in processPayment".
- The rest of the description must then describe THAT specific symbol's vulnerability — not a sibling's. If, while writing, you find yourself describing a different route/function than the one you opened with, stop: you are hallucinating across targets. Discard the issue and return {"issues": []}.
- If you noticed a real vulnerability while reading the file but it is in a sibling location, do NOT smuggle it into this target's report. That sibling has its own target run.
`;
}

export const semgrepDiscovery: TargetDiscovery = {
  name: 'semgrep',
  defaultGenericPrompt: DEFAULT_GENERIC_PROMPT,
  needsInstructions: true,
  supportsDiffFilter: true,

  async discover(
    check: SecurityCheck,
    repoPath: string,
    _options?: DiscoveryOptions,
  ): Promise<DiscoveredTarget[]> {
    const checkTarget = check.checkTarget!;

    logDebug(TAG, `Running Semgrep for check: ${check.id}`);

    const sarifContent = await runSemgrep({
      repositoryPath: repoPath,
      rules: checkTarget.rules,
      config: checkTarget.config,
    });

    let targets = parseSARIF(sarifContent);
    targets = deduplicateTargets(targets);

    logDebug(TAG, `Discovered ${targets.length} targets`);

    return targets.map((target, idx) => ({
      file: target.file,
      startLine: target.startLine,
      endLine: target.endLine,
      label: `[target ${idx + 1}/${targets.length}]`,
      message: target.message,
      snippet: target.snippet,
      promptEnrichment: buildTargetPromptEnrichment(target.file, target.startLine, target.endLine),
    }));
  },
};
