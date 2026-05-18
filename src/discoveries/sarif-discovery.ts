/**
 * SARIF-based target discovery.
 *
 * Reads an external SARIF file (e.g. from another SAST tool) and
 * returns findings as targets for AI analysis.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseSARIF, deduplicateTargets } from '../sarif-parser.js';
import { logDebug } from '../logging.js';
import { ERROR_CODES, formatError } from '../error-codes.js';
import { DEFAULT_GENERIC_PROMPT } from '../defaults.js';
import type { TargetDiscovery, DiscoveredTarget, DiscoveryOptions } from '../discovery.js';
import type { SecurityCheck } from '../types.js';

const TAG = 'sarif-discovery';

function buildFindingPromptEnrichment(
  file: string,
  startLine: number,
  endLine: number,
  message: string,
  snippet?: string,
): string {
  const snippetSection = snippet ? `\n- Code snippet from tool: ${snippet}` : '';
  return `\n\nFINDING DETAILS:

- File: ${file}
- Lines: ${startLine}-${endLine}
- Tool's finding description: ${message}${snippetSection}

You MUST:
- Analyze ONLY this specific finding — do not search for or report issues at other locations
- You may read other files to understand context (e.g., imports, type definitions, data flow), but only report issues for this finding
- Do NOT scan the broader repository for other vulnerability patterns
`;
}

export const sarifDiscovery: TargetDiscovery = {
  name: 'sarif',
  defaultGenericPrompt: DEFAULT_GENERIC_PROMPT,
  needsInstructions: true,
  supportsDiffFilter: true,

  async discover(
    check: SecurityCheck,
    repoPath: string,
    _options?: DiscoveryOptions,
  ): Promise<DiscoveredTarget[]> {
    const checkTarget = check.checkTarget!;

    if (!checkTarget.sarifFile) {
      throw new Error(
        formatError(ERROR_CODES.E2004, `Check "${check.id}" uses sarif discovery but has no "sarifFile" in its check definition`),
      );
    }

    // Resolve sarifFile relative to the target repo
    const sarifFilePath = resolve(repoPath, checkTarget.sarifFile);

    logDebug(TAG, `Reading SARIF file: ${sarifFilePath}`);
    const sarifContent = await readFile(sarifFilePath, 'utf-8');

    let targets = parseSARIF(sarifContent);
    targets = deduplicateTargets(targets);

    logDebug(TAG, `Discovered ${targets.length} findings`);

    return targets.map((target, idx) => ({
      file: target.file,
      startLine: target.startLine,
      endLine: target.endLine,
      label: `[finding ${idx + 1}/${targets.length}]`,
      message: target.message,
      snippet: target.snippet,
      promptEnrichment: buildFindingPromptEnrichment(
        target.file,
        target.startLine,
        target.endLine,
        target.message,
        target.snippet,
      ),
    }));
  },
};
