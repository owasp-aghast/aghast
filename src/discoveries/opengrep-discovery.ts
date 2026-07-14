/**
 * Opengrep-based target discovery.
 *
 * Runs Opengrep rules (drop-in-compatible with Semgrep rules) against the
 * repository, parses SARIF output, and returns discovered targets with
 * inline prompt enrichment.
 */

import { runOpengrep } from '../opengrep-runner.js';
import { parseSARIF, deduplicateTargets } from '../sarif-parser.js';
import { logDebug } from '../logging.js';
import { buildSarifTargetPromptEnrichment } from './sarif-target-enrichment.js';
import { DEFAULT_GENERIC_PROMPT } from '../defaults.js';
import type { TargetDiscovery, DiscoveredTarget, DiscoveryOptions } from '../discovery.js';
import type { SecurityCheck } from '../types.js';

const TAG = 'opengrep-discovery';

export const opengrepDiscovery: TargetDiscovery = {
  name: 'opengrep',
  defaultGenericPrompt: DEFAULT_GENERIC_PROMPT,
  needsInstructions: true,
  supportsDiffFilter: true,

  async discover(
    check: SecurityCheck,
    repoPath: string,
    _options?: DiscoveryOptions,
  ): Promise<DiscoveredTarget[]> {
    const checkTarget = check.checkTarget!;

    logDebug(TAG, `Running Opengrep for check: ${check.id}`);

    const sarifContent = await runOpengrep({
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
      promptEnrichment: buildSarifTargetPromptEnrichment(target.file, target.startLine, target.endLine),
    }));
  },
};
