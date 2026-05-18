/**
 * OpenAnt-based target discovery.
 *
 * Runs `openant parse` against the repository (or uses a mock dataset),
 * filters the resulting code units, and returns them as targets with
 * rich prompt enrichment (call graph, entry points, metadata).
 */

import { runOpenAnt } from '../openant-runner.js';
import { loadDatasetFromFile, filterUnits, formatUnitPromptSection } from '../openant-loader.js';
import { logProgress, logDebug } from '../logging.js';
import { DEFAULT_GENERIC_PROMPT } from '../defaults.js';
import type { TargetDiscovery, DiscoveredTarget, DiscoveryOptions } from '../discovery.js';
import type { SecurityCheck } from '../types.js';

const TAG = 'openant-discovery';

export const openantDiscovery: TargetDiscovery = {
  name: 'openant',
  defaultGenericPrompt: DEFAULT_GENERIC_PROMPT,
  needsInstructions: true,
  supportsDiffFilter: true,

  async discover(
    check: SecurityCheck,
    repoPath: string,
    options?: DiscoveryOptions,
  ): Promise<DiscoveredTarget[]> {
    const checkTarget = check.checkTarget!;

    // Reuse the scan runner's dataset when provided, otherwise run OpenAnt ourselves.
    let datasetPath: string;
    let cleanup: (() => Promise<void>) | undefined;
    if (options?.openantDatasetPath) {
      logDebug(TAG, `Reusing preloaded OpenAnt dataset: ${options.openantDatasetPath}`);
      datasetPath = options.openantDatasetPath;
    } else {
      ({ datasetPath, cleanup } = await runOpenAnt(repoPath));
    }

    try {
      // Load and filter units
      const dataset = await loadDatasetFromFile(datasetPath);
      const totalUnits = dataset.units.length;
      const units = filterUnits(dataset.units, checkTarget.openant);

      logProgress(TAG, `Loaded ${totalUnits} units (${units.length} after filtering)`);

      return units.map((unit, idx) => {
        const origin = unit.code.primary_origin;
        return {
          file: origin.file_path,
          startLine: origin.start_line,
          endLine: origin.end_line,
          label: `[unit ${idx + 1}/${units.length}]`,
          promptEnrichment: formatUnitPromptSection(unit),
          agentOptions: { maxTurns: 20 },
        };
      });
    } finally {
      if (cleanup) {
        await cleanup();
        logDebug(TAG, 'Cleaned up temporary OpenAnt output');
      }
    }
  },
};
