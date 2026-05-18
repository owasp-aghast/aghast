/**
 * Unit-to-diff matching with call graph traversal.
 *
 * Determines which OpenAnt code units are "touched" by a git diff:
 * - Tier 1 (direct): unit's code region overlaps with a changed region
 * - Tier 2 (flow): unit is a caller or callee of a directly-touched unit
 *
 * Also filters Semgrep findings to only those within touched units
 * (or in files without OpenAnt coverage that have diff changes).
 */

import type { OpenAntUnit } from './openant-loader.js';
import type { DiffMap, DiffHunk } from './diff-parser.js';

/**
 * Normalize file path to forward slashes for cross-platform comparison.
 * Diffs always use forward slashes; OpenAnt uses backslashes on Windows.
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Look up a file in the DiffMap, normalising the key for cross-platform matching.
 */
export function diffMapGet(diffMap: DiffMap, filePath: string): DiffHunk[] | undefined {
  // Try exact match first (fast path)
  const exact = diffMap.get(filePath);
  if (exact) return exact;
  // Fall back to normalised comparison
  const normalized = normalizePath(filePath);
  for (const [key, value] of diffMap) {
    if (normalizePath(key) === normalized) return value;
  }
  return undefined;
}

/**
 * Check whether a file exists in the DiffMap, normalising for cross-platform matching.
 */
function diffMapHas(diffMap: DiffMap, filePath: string): boolean {
  return diffMapGet(diffMap, filePath) !== undefined;
}

/**
 * Check whether two line ranges overlap.
 */
export function rangesOverlap(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

/**
 * Find all OpenAnt units that are "touched" by the diff.
 *
 * A unit is touched if:
 * 1. Its code region directly overlaps with a changed region (Tier 1)
 * 2. It is within `depth` hops in the call graph of a directly-touched unit (Tier 2)
 *
 * @param units All OpenAnt units (after any configured filtering)
 * @param diffMap Changed regions from the parsed diff
 * @param depth Call graph hops to follow (default: 1). 0 = direct only.
 */
export function findTouchedUnits(
  units: OpenAntUnit[],
  diffMap: DiffMap,
  depth: number = 1,
): OpenAntUnit[] {
  const touchedIds = new Set<string>();

  // Tier 1: direct overlap with diff
  for (const unit of units) {
    const origin = unit.code.primary_origin;
    const regions = diffMapGet(diffMap, origin.file_path);
    if (regions && regions.some(r => rangesOverlap(origin.start_line, origin.end_line, r.startLine, r.endLine))) {
      touchedIds.add(unit.id);
    }
  }

  // Tier 2: call graph adjacency (N hops)
  //
  // Build a lookup of all identifiers that can refer to a unit: its id,
  // its function_name, and its file_path:function_name. OpenAnt uses
  // different formats across versions (qualified "file:func" in direct_calls
  // vs unqualified "func" in function_name), so we match against all.
  const unitIdsByName = new Map<string, Set<string>>();
  for (const unit of units) {
    const origin = unit.code.primary_origin;
    const names = [
      unit.id,
      origin.function_name,
      `${normalizePath(origin.file_path)}:${origin.function_name}`,
    ];
    for (const name of names) {
      if (!unitIdsByName.has(name)) unitIdsByName.set(name, new Set());
      unitIdsByName.get(name)!.add(unit.id);
    }
  }

  for (let hop = 0; hop < depth; hop++) {
    const newlyTouched = new Set<string>();

    // For each currently touched unit, find its direct callees and callers
    for (const unit of units) {
      if (!touchedIds.has(unit.id)) continue;
      const meta = unit.metadata;

      // Units that this touched unit calls (callees)
      for (const calleeName of (meta.direct_calls ?? [])) {
        const calleeIds = unitIdsByName.get(calleeName) ?? unitIdsByName.get(normalizePath(calleeName));
        if (calleeIds) {
          for (const id of calleeIds) {
            if (!touchedIds.has(id)) newlyTouched.add(id);
          }
        }
      }

      // Units that call this touched unit (callers)
      for (const callerName of (meta.direct_callers ?? [])) {
        const callerIds = unitIdsByName.get(callerName) ?? unitIdsByName.get(normalizePath(callerName));
        if (callerIds) {
          for (const id of callerIds) {
            if (!touchedIds.has(id)) newlyTouched.add(id);
          }
        }
      }
    }

    if (newlyTouched.size === 0) break;
    for (const id of newlyTouched) touchedIds.add(id);
  }

  return units.filter(u => touchedIds.has(u.id));
}

/**
 * Filter discovered findings to only those within the scope of touched units.
 *
 * Two-path logic:
 * - Path A: Files with OpenAnt coverage — finding must be inside a touched unit
 * - Path B: Files without OpenAnt coverage — include all findings if the file has diff changes
 *
 * Generic over T so any object carrying file/startLine/endLine (DiscoveredTarget,
 * CheckTarget, etc.) can be filtered without conversion.
 */
export function filterFindingsByScope<T extends { file: string; startLine: number; endLine: number }>(
  findings: T[],
  touchedUnits: OpenAntUnit[],
  allUnits: OpenAntUnit[],
  diffMap: DiffMap,
): T[] {
  // Determine which files have OpenAnt coverage (normalised for cross-platform)
  const coveredFiles = new Set<string>();
  for (const unit of allUnits) {
    coveredFiles.add(normalizePath(unit.code.primary_origin.file_path));
  }

  return findings.filter(finding => {
    const normalizedFindingFile = normalizePath(finding.file);
    if (coveredFiles.has(normalizedFindingFile)) {
      // Path A: file has OpenAnt units — finding must overlap with a touched unit
      // Uses overlap rather than strict containment because discovery tools may
      // include context lines (e.g. Semgrep includes decorators above a function)
      return touchedUnits.some(unit => {
        const origin = unit.code.primary_origin;
        return (
          normalizedFindingFile === normalizePath(origin.file_path) &&
          rangesOverlap(finding.startLine, finding.endLine, origin.start_line, origin.end_line)
        );
      });
    } else {
      // Path B: file has NO OpenAnt units — include if file has diff changes
      return diffMapHas(diffMap, finding.file);
    }
  });
}
