/**
 * Diff filter.
 *
 * Post-discovery transformation that narrows a set of DiscoveredTargets to
 * those touching code changed in a git diff. Uses OpenAnt's call graph to
 * widen scope to callers/callees of directly-changed units (flow adjacency).
 *
 * Applied by the scan runner when `checkTarget.diffFilter` is true on a
 * discovery that opts in via `supportsDiffFilter`.
 *
 * Pipeline:
 * 1. Resolve diff source (--diff-file > --diff-ref > check-level diffRef).
 * 2. Parse diff into changed regions per file.
 * 3. Run OpenAnt to get units + call graph.
 * 4. Find touched units: direct overlap plus `diffFlowDepth` call-graph hops.
 * 5. Filter the input targets to those inside a touched unit, OR in a file
 *    with no OpenAnt coverage but present in the diff.
 * 6. Reindex labels and append a note to each surviving target's prompt so
 *    the AI knows this target was selected via diff scoping.
 */

import { parseDiff, getDiff, loadDiffFromFile } from './diff-parser.js';
import { runOpenAnt } from './openant-runner.js';
import { loadDatasetFromFile, filterUnits } from './openant-loader.js';
import {
  findTouchedUnits,
  filterFindingsByScope,
  diffMapGet,
  rangesOverlap,
} from './diff-unit-matcher.js';
import { logProgress, logDebug } from './logging.js';
import type { DiscoveredTarget } from './discovery.js';
import type { OpenAntFilterConfig, SecurityCheck } from './types.js';

const TAG = 'diff-filter';

export interface DiffFilterOptions {
  /** Git ref to diff against (e.g. 'main', 'HEAD~1'). */
  diffRef?: string;
  /** Path to a pre-generated unified diff file. */
  diffFile?: string;
  /** Filter applied to OpenAnt units before touched-unit detection. */
  openant?: OpenAntFilterConfig;
  /**
   * Preloaded OpenAnt dataset path. When provided, skip the internal
   * runOpenAnt call and read from this path. Lets the scan runner share
   * one OpenAnt invocation across discovery + diff filter.
   */
  openantDatasetPath?: string;
  /**
   * Run in depth-0 mode without OpenAnt. Targets are kept iff their file
   * appears in the diff AND their line range overlaps a diff hunk.
   * Call-graph adjacency (direct callers/callees of changed units) is
   * not applied. Used as a graceful fallback when OpenAnt is unavailable.
   */
  depthZero?: boolean;
}

/**
 * Call-graph hops applied when widening diff scope beyond directly-changed units.
 * Depth 1 means "include direct callers and callees of changed units" — the sweet
 * spot for security review (captures broken contracts in adjacent functions
 * without the noise of chained fan-out). Not user-configurable.
 */
const DIFF_FLOW_DEPTH = 1;

const DIFF_SCOPE_NOTE =
  '\n\nNote: this target was selected by diff filtering. It corresponds to code that was directly changed in the diff, or is in the immediate call-graph flow of a change. Focus your analysis on whether the change introduces or affects the vulnerability at this location.';

/**
 * Apply diff filtering to a set of discovered targets.
 * Returns the subset whose file/lines fall inside a diff-touched code unit
 * (or in an uncovered file that appears in the diff).
 */
export async function applyDiffFilter(
  check: SecurityCheck,
  targets: DiscoveredTarget[],
  repoPath: string,
  options: DiffFilterOptions,
): Promise<DiscoveredTarget[]> {
  logProgress(TAG, 'Parsing diff...');
  const diffMap = await resolveDiff(check, repoPath, options);

  if (diffMap.size === 0) {
    logProgress(TAG, 'Diff is empty — no changed files, returning no targets');
    return [];
  }
  logDebug(TAG, `Diff contains changes in ${diffMap.size} files`);

  if (targets.length === 0) {
    logDebug(TAG, 'No discovered targets to filter');
    return [];
  }

  // Depth-0 fallback: skip OpenAnt entirely and filter by file/line overlap only.
  // Invoked when OpenAnt is unavailable and the scan runner has opted in.
  if (options.depthZero) {
    const filtered = targets.filter((target) => {
      const regions = diffMapGet(diffMap, target.file);
      if (!regions) return false;
      return regions.some((r) => rangesOverlap(target.startLine, target.endLine, r.startLine, r.endLine));
    });

    logProgress(
      TAG,
      `Diff filter (depth-0, no call graph): ${targets.length} discovered targets → ${filtered.length} in diff scope`,
    );

    return filtered.map((target, idx) => ({
      ...target,
      label: relabel(target.label, idx, filtered.length),
      promptEnrichment: (target.promptEnrichment ?? '') + DIFF_SCOPE_NOTE,
    }));
  }

  // Use the preloaded dataset if the scan runner provided one; otherwise run
  // OpenAnt ourselves (with cleanup responsibility).
  let datasetPath: string;
  let cleanup: (() => Promise<void>) | undefined;
  if (options.openantDatasetPath) {
    logDebug(TAG, `Reusing preloaded OpenAnt dataset: ${options.openantDatasetPath}`);
    datasetPath = options.openantDatasetPath;
  } else {
    logProgress(TAG, 'Running OpenAnt for code unit discovery...');
    ({ datasetPath, cleanup } = await runOpenAnt(repoPath));
  }

  try {
    const dataset = await loadDatasetFromFile(datasetPath);
    const allUnits = filterUnits(dataset.units, options.openant);
    logDebug(TAG, `Loaded ${dataset.units.length} units (${allUnits.length} after filtering)`);

    const directlyTouched = findTouchedUnits(allUnits, diffMap, 0);
    const touchedUnits = findTouchedUnits(allUnits, diffMap, DIFF_FLOW_DEPTH);
    const flowTouched = touchedUnits.length - directlyTouched.length;

    logProgress(
      TAG,
      `Diff scope: ${directlyTouched.length} of ${allUnits.length} units directly changed` +
        `${flowTouched > 0 ? `, ${flowTouched} more via call graph` : ''}` +
        ` — ${touchedUnits.length} units in scope`,
    );

    const filtered = filterFindingsByScope(targets, touchedUnits, allUnits, diffMap);
    logProgress(
      TAG,
      `Diff filter: ${targets.length} discovered targets → ${filtered.length} in diff scope`,
    );

    return filtered.map((target, idx) => ({
      ...target,
      label: relabel(target.label, idx, filtered.length),
      promptEnrichment: (target.promptEnrichment ?? '') + DIFF_SCOPE_NOTE,
    }));
  } finally {
    if (cleanup) {
      await cleanup();
      logDebug(TAG, 'Cleaned up temporary OpenAnt output');
    }
  }
}

/**
 * Produce a new label that keeps the original kind word ("target", "finding",
 * "unit") but uses the post-filter indices. Falls back to "[target N/M]".
 */
function relabel(original: string, idx: number, total: number): string {
  const match = original.match(/^\[([a-zA-Z]+)\s/);
  const kind = match ? match[1] : 'target';
  return `[${kind} ${idx + 1}/${total}]`;
}

async function resolveDiff(
  check: SecurityCheck,
  repoPath: string,
  options: DiffFilterOptions,
): Promise<ReturnType<typeof parseDiff>> {
  if (options.diffFile) {
    logDebug(TAG, `Using diff file: ${options.diffFile}`);
    const diffText = await loadDiffFromFile(options.diffFile);
    return parseDiff(diffText);
  }

  const diffRef = options.diffRef ?? check.checkTarget?.diffRef;
  if (diffRef) {
    logDebug(TAG, `Running git diff against ref: ${diffRef}`);
    const diffText = await getDiff(repoPath, diffRef);
    return parseDiff(diffText);
  }

  // Unreachable in normal flow — the scan runner only calls applyDiffFilter
  // when a diff source is available. Defensive guard for direct callers.
  throw new Error(
    `applyDiffFilter called for check "${check.id}" with no diff source. This is a bug; the scan runner gates invocation on source availability.`,
  );
}
