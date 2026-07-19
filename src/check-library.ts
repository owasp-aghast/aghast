/**
 * Check Library / Config Manager.
 * Two-layer config: Layer 1 (registry) maps checks to repos,
 * Layer 2 (<id>.json) defines each check in its own folder.
 * Implements spec Appendix B.1.
 */

import { readFile, readdir, access, constants } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import picomatch from 'picomatch';
import { normalizeRepoPath } from './repository-analyzer.js';
import type {
  SecurityCheck,
  CheckDetails,
  CheckRegistryEntry,
  CheckDefinition,
} from './types.js';
import { getCheckType, getValidCheckTypes } from './check-types.js';
import { getRegisteredDiscoveries } from './discovery.js';

// --- Layer 1: Check Registry ---

export interface CheckRegistry {
  checks: CheckRegistryEntry[];
}

/**
 * Load and parse the Layer 1 registry from <configDir>/checks-config.json.
 * Throws on missing file, malformed JSON, or invalid structure.
 */
export async function loadCheckRegistry(configDir: string): Promise<CheckRegistry> {
  const configPath = resolve(configDir, 'checks-config.json');
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read config file "${configPath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config file "${configPath}" contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('checks' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).checks)
  ) {
    throw new Error(
      `Config file "${configPath}" has invalid structure: must contain a "checks" array`,
    );
  }

  // Validate each registry entry has required fields with correct types
  const checks = (parsed as Record<string, unknown>).checks as unknown[];
  for (let i = 0; i < checks.length; i++) {
    const entry = checks[i];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Config file "${configPath}": checks[${i}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== 'string' || obj.id.trim() === '') {
      throw new Error(`Config file "${configPath}": checks[${i}].id must be a non-empty string`);
    }
    if (!Array.isArray(obj.repositories)) {
      throw new Error(`Config file "${configPath}": checks[${i}].repositories must be an array`);
    }
    for (let j = 0; j < obj.repositories.length; j++) {
      if (typeof obj.repositories[j] !== 'string') {
        throw new Error(`Config file "${configPath}": checks[${i}].repositories[${j}] must be a string`);
      }
    }
    if (obj.excludeRepositories !== undefined) {
      if (!Array.isArray(obj.excludeRepositories)) {
        throw new Error(
          `Config file "${configPath}": checks[${i}].excludeRepositories must be an array`,
        );
      }
      for (let j = 0; j < obj.excludeRepositories.length; j++) {
        if (typeof obj.excludeRepositories[j] !== 'string') {
          throw new Error(
            `Config file "${configPath}": checks[${i}].excludeRepositories[${j}] must be a string`,
          );
        }
      }
    }
    if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
      throw new Error(`Config file "${configPath}": checks[${i}].enabled must be a boolean`);
    }
  }

  return parsed as CheckRegistry;
}

// --- Layer 2: Check Definitions ---

/**
 * Load and parse a Layer 2 check definition from <checkFolderPath>/<id>.json.
 * Throws on missing file, malformed JSON, or missing required fields.
 */
export async function loadCheckDefinition(checkFolderPath: string): Promise<CheckDefinition> {
  const defPath = resolve(checkFolderPath, basename(checkFolderPath) + '.json');
  let raw: string;
  try {
    raw = await readFile(defPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read check definition "${defPath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Check definition "${defPath}" contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Validate field types before casting
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    throw new Error(`Check definition "${defPath}": "id" must be a non-empty string`);
  }
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    throw new Error(`Check definition "${defPath}": "name" must be a non-empty string`);
  }
  if (obj.instructionsFile !== undefined && typeof obj.instructionsFile !== 'string') {
    throw new Error(`Check definition "${defPath}": "instructionsFile" must be a string`);
  }
  if (obj.severity !== undefined && typeof obj.severity !== 'string') {
    throw new Error(`Check definition "${defPath}": "severity" must be a string`);
  }
  if (obj.confidence !== undefined && typeof obj.confidence !== 'string') {
    throw new Error(`Check definition "${defPath}": "confidence" must be a string`);
  }
  if (obj.model !== undefined && typeof obj.model !== 'string') {
    throw new Error(`Check definition "${defPath}": "model" must be a string`);
  }
  if (obj.applicablePaths !== undefined && !Array.isArray(obj.applicablePaths)) {
    throw new Error(`Check definition "${defPath}": "applicablePaths" must be an array`);
  }
  if (obj.excludedPaths !== undefined && !Array.isArray(obj.excludedPaths)) {
    throw new Error(`Check definition "${defPath}": "excludedPaths" must be an array`);
  }
  if (obj.checkTarget !== undefined) {
    if (typeof obj.checkTarget !== 'object' || obj.checkTarget === null) {
      throw new Error(`Check definition "${defPath}": "checkTarget" must be an object`);
    }
    const ct = obj.checkTarget as Record<string, unknown>;
    const validTypes = getValidCheckTypes();
    if (typeof ct.type !== 'string' || !validTypes.includes(ct.type)) {
      throw new Error(`Check definition "${defPath}": "checkTarget.type" must be one of: ${validTypes.join(', ')}`);
    }
    if (ct.rules !== undefined && typeof ct.rules !== 'string' && !Array.isArray(ct.rules)) {
      throw new Error(`Check definition "${defPath}": "checkTarget.rules" must be a string or array`);
    }
    if (ct.config !== undefined && typeof ct.config !== 'string') {
      throw new Error(`Check definition "${defPath}": "checkTarget.config" must be a string`);
    }
    if (ct.maxTargets !== undefined && (typeof ct.maxTargets !== 'number' || ct.maxTargets <= 0 || !Number.isInteger(ct.maxTargets))) {
      throw new Error(`Check definition "${defPath}": "checkTarget.maxTargets" must be a positive integer`);
    }
    if (ct.concurrency !== undefined && (typeof ct.concurrency !== 'number' || ct.concurrency <= 0 || !Number.isInteger(ct.concurrency))) {
      throw new Error(`Check definition "${defPath}": "checkTarget.concurrency" must be a positive integer`);
    }
    if (ct.maxIssuesPerTarget !== undefined && (typeof ct.maxIssuesPerTarget !== 'number' || ct.maxIssuesPerTarget < 1 || !Number.isInteger(ct.maxIssuesPerTarget))) {
      throw new Error(`Check definition "${defPath}": "checkTarget.maxIssuesPerTarget" must be a positive integer`);
    }
    // Validate discovery field is present for targeted/static types (actual type
    // validation happens in validateCheck, after repo filtering, so unknown
    // discovery types don't crash the entire scan for unrelated checks)
    if (ct.type === 'targeted' || ct.type === 'static') {
      if (typeof ct.discovery !== 'string' || ct.discovery.trim() === '') {
        throw new Error(
          `Check definition "${defPath}": "checkTarget.discovery" is required for type "${ct.type}"`,
        );
      }
    }
    if (ct.sarifFile !== undefined && typeof ct.sarifFile !== 'string') {
      throw new Error(`Check definition "${defPath}": "checkTarget.sarifFile" must be a string`);
    }
    if (ct.discovery === 'sarif' && !ct.sarifFile) {
      throw new Error(
        `Check definition "${defPath}": "checkTarget.sarifFile" is required when discovery is "sarif"`,
      );
    }
    // Validate diff filter fields
    if (ct.diffFilter !== undefined && typeof ct.diffFilter !== 'boolean') {
      throw new Error(`Check definition "${defPath}": "checkTarget.diffFilter" must be a boolean`);
    }
    if (ct.diffRef !== undefined && typeof ct.diffRef !== 'string') {
      throw new Error(`Check definition "${defPath}": "checkTarget.diffRef" must be a string`);
    }

    // Validate glob discovery fields
    if (ct.glob !== undefined && (typeof ct.glob !== 'string' || ct.glob.trim() === '')) {
      throw new Error(
        `Check definition "${defPath}": "checkTarget.glob" must be a non-empty string`,
      );
    }
    if (ct.discovery === 'glob' && (typeof ct.glob !== 'string' || ct.glob.trim() === '')) {
      throw new Error(
        `Check definition "${defPath}": "checkTarget.glob" must be a non-empty string when discovery is "glob"`,
      );
    }

    // Validate script-discovery fields
    if (ct.script !== undefined && typeof ct.script !== 'string') {
      throw new Error(`Check definition "${defPath}": "checkTarget.script" must be a string`);
    }
    if (ct.scriptType !== undefined) {
      if (typeof ct.scriptType !== 'string' || (ct.scriptType !== 'node' && ct.scriptType !== 'bash')) {
        throw new Error(
          `Check definition "${defPath}": "checkTarget.scriptType" must be "node" or "bash"`,
        );
      }
    }
    if (ct.outputFormat !== undefined) {
      if (
        typeof ct.outputFormat !== 'string' ||
        (ct.outputFormat !== 'lines' &&
          ct.outputFormat !== 'json-array' &&
          ct.outputFormat !== 'json-object')
      ) {
        throw new Error(
          `Check definition "${defPath}": "checkTarget.outputFormat" must be one of "lines", "json-array", "json-object"`,
        );
      }
    }
    if (ct.cwd !== undefined && typeof ct.cwd !== 'string') {
      throw new Error(`Check definition "${defPath}": "checkTarget.cwd" must be a string`);
    }
    if (
      ct.timeoutMs !== undefined &&
      (typeof ct.timeoutMs !== 'number' || ct.timeoutMs <= 0 || !Number.isFinite(ct.timeoutMs))
    ) {
      throw new Error(
        `Check definition "${defPath}": "checkTarget.timeoutMs" must be a positive number`,
      );
    }
    if (ct.discovery === 'script') {
      if (typeof ct.script !== 'string' || ct.script.trim() === '') {
        throw new Error(
          `Check definition "${defPath}": "checkTarget.script" is required when discovery is "script"`,
        );
      }
      if (typeof ct.scriptType !== 'string') {
        throw new Error(
          `Check definition "${defPath}": "checkTarget.scriptType" is required when discovery is "script"`,
        );
      }
      if (typeof ct.outputFormat !== 'string') {
        throw new Error(
          `Check definition "${defPath}": "checkTarget.outputFormat" is required when discovery is "script"`,
        );
      }
    }
    // Validate openant filter config
    if (ct.openant !== undefined) {
      if (typeof ct.openant !== 'object' || ct.openant === null) {
        throw new Error(`Check definition "${defPath}": "checkTarget.openant" must be an object`);
      }
      const oa = ct.openant as Record<string, unknown>;
      if (oa.unitTypes !== undefined && !Array.isArray(oa.unitTypes)) {
        throw new Error(`Check definition "${defPath}": "checkTarget.openant.unitTypes" must be an array`);
      }
      if (oa.excludeUnitTypes !== undefined && !Array.isArray(oa.excludeUnitTypes)) {
        throw new Error(`Check definition "${defPath}": "checkTarget.openant.excludeUnitTypes" must be an array`);
      }
      if (oa.securityClassifications !== undefined && !Array.isArray(oa.securityClassifications)) {
        throw new Error(`Check definition "${defPath}": "checkTarget.openant.securityClassifications" must be an array`);
      }
      if (oa.reachableOnly !== undefined && typeof oa.reachableOnly !== 'boolean') {
        throw new Error(`Check definition "${defPath}": "checkTarget.openant.reachableOnly" must be a boolean`);
      }
      if (oa.entryPointsOnly !== undefined && typeof oa.entryPointsOnly !== 'boolean') {
        throw new Error(`Check definition "${defPath}": "checkTarget.openant.entryPointsOnly" must be a boolean`);
      }
      if (oa.minConfidence !== undefined && (typeof oa.minConfidence !== 'number' || oa.minConfidence < 0 || oa.minConfidence > 1)) {
        throw new Error(`Check definition "${defPath}": "checkTarget.openant.minConfidence" must be a number between 0 and 1`);
      }
    }
  }

  const def = parsed as CheckDefinition;

  // instructionsFile is required for check types where needsInstructions is true,
  // UNLESS analysisMode is a built-in mode (false-positive-validation, general-vuln-discovery)
  // which provides its own prompt template.
  const builtInMode = def.checkTarget?.analysisMode === 'false-positive-validation'
    || def.checkTarget?.analysisMode === 'general-vuln-discovery';
  if (getCheckType(def.checkTarget?.type).needsInstructions && !builtInMode && !def.instructionsFile) {
    throw new Error(
      `Check definition "${defPath}" is missing required field "instructionsFile"`,
    );
  }

  return def;
}

/**
 * Scan check directories for subfolders containing <id>.json.
 * Returns a map of check id → folder path.
 */
export async function discoverCheckFolders(
  checksDirs: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const dir of checksDirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Directory doesn't exist — skip
      continue;
    }

    for (const entry of entries) {
      const folderPath = join(dir, entry);
      const checkJsonPath = join(folderPath, entry + '.json');
      try {
        await access(checkJsonPath, constants.R_OK);
        // Load just to get the id
        const def = await loadCheckDefinition(folderPath);
        result.set(def.id, folderPath);
      } catch {
        // Not a check folder or can't read — skip
      }
    }
  }

  return result;
}

/**
 * Merge Layer 1 registry entries with Layer 2 check definitions.
 * Resolves instructionsFile and checkTarget.rules paths relative to check folder.
 * Throws if a registry entry has no matching check folder.
 */
export async function resolveChecks(
  registry: CheckRegistry,
  checkFolders: Map<string, string>,
): Promise<SecurityCheck[]> {
  const checks: SecurityCheck[] = [];

  for (const entry of registry.checks) {
    const folderPath = checkFolders.get(entry.id);
    if (!folderPath) {
      throw new Error(
        `Check "${entry.id}" is registered but no matching check folder was found in any checks directory`,
      );
    }

    const def = await loadCheckDefinition(folderPath);
    if (def.id !== entry.id) {
      throw new Error(
        `Check ID mismatch: registry has "${entry.id}" but ${entry.id}.json has "${def.id}"`,
      );
    }

    // Merge Layer 1 + Layer 2
    const merged: SecurityCheck = {
      id: entry.id,
      name: def.name,
      repositories: entry.repositories,
      excludeRepositories: entry.excludeRepositories,
      instructionsFile: def.instructionsFile ? resolve(folderPath, def.instructionsFile) : undefined,
      enabled: entry.enabled,
      checkDir: folderPath,
    };

    if (def.severity) merged.severity = def.severity;
    if (def.confidence) merged.confidence = def.confidence;
    if (def.model) merged.model = def.model;
    if (def.applicablePaths) merged.applicablePaths = def.applicablePaths;
    if (def.excludedPaths) merged.excludedPaths = def.excludedPaths;

    if (def.checkTarget) {
      merged.checkTarget = { ...def.checkTarget };
      // Resolve rules paths relative to check folder
      if (merged.checkTarget.rules) {
        const rules = merged.checkTarget.rules;
        merged.checkTarget.rules = Array.isArray(rules)
          ? rules.map((r) => resolve(folderPath, r))
          : resolve(folderPath, rules);
      }
      if (merged.checkTarget.config) {
        merged.checkTarget.config = resolve(folderPath, merged.checkTarget.config);
      }
    }

    checks.push(merged);
  }

  return checks;
}

// --- Backward-compatible loadConfig (for tests that use the old flat format) ---

export interface CheckLibraryConfig {
  checks: SecurityCheck[];
}

/**
 * Load and parse a flat JSON config file (old format).
 * Kept for backward compatibility with existing test fixtures.
 */
export async function loadConfig(configPath: string): Promise<CheckLibraryConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read config file "${configPath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config file "${configPath}" contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('checks' in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).checks)
  ) {
    throw new Error(
      `Config file "${configPath}" has invalid structure: must contain a "checks" array`,
    );
  }

  return parsed as CheckLibraryConfig;
}

// --- Validation ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a single SecurityCheck definition.
 * Checks that id is present and non-empty, and instructionsFile exists on disk.
 * basePath is used to resolve instructionsFile if it's a relative path.
 * If instructionsFile is already absolute, basePath is ignored.
 */
export async function validateCheck(
  check: SecurityCheck,
  basePath: string,
): Promise<ValidationResult> {
  const errors: string[] = [];

  if (!check.id || typeof check.id !== 'string' || check.id.trim() === '') {
    errors.push('Check is missing a valid "id" field');
  }

  // Validate discovery type is registered (checked here, after repo filtering,
  // so unknown discovery types in unrelated checks don't crash the scan).
  // Only validates when discoveries have been registered (skips in unit tests
  // where scan-runner.ts hasn't been imported).
  const discovery = check.checkTarget?.discovery;
  const registered = getRegisteredDiscoveries();
  if (discovery && registered.length > 0 && !registered.includes(discovery)) {
    errors.push(`Unknown discovery type "${discovery}". Available: ${registered.join(', ')}`);
  }

  // Built-in analysis modes provide their own prompt template — no instructionsFile needed
  const builtInModeV = check.checkTarget?.analysisMode === 'false-positive-validation'
    || check.checkTarget?.analysisMode === 'general-vuln-discovery';
  if (!getCheckType(check.checkTarget?.type).needsInstructions || builtInModeV) {
    // No instructionsFile validation needed for this check type/discovery
  } else if (!check.instructionsFile) {
    errors.push('Check is missing required "instructionsFile" field');
  } else {
    // instructionsFile may already be an absolute path (from resolveChecks)
    const instructionsPath = resolve(basePath, check.instructionsFile);
    try {
      const markdown = await readFile(instructionsPath, 'utf-8');
      if (markdown.trim() === '') {
        errors.push(
          `Instructions file "${check.instructionsFile}" is empty`,
        );
      }
    } catch {
      errors.push(
        `Instructions file "${check.instructionsFile}" not found at "${instructionsPath}"`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Repository Matching (spec C.6) ---

// Re-export normalizeRepoPath from repository-analyzer for convenience
export { normalizeRepoPath } from './repository-analyzer.js';

/**
 * Check if a single check matches the given repository URL/path.
 * Empty repositories array matches all repos.
 * Entries in excludeRepositories override matches (exclusion wins).
 * Uses bidirectional substring matching on normalized paths.
 */
export function checkMatchesRepository(
  check: SecurityCheck,
  repositoryUrl: string,
): boolean {
  const normalizedRepo = normalizeRepoPath(repositoryUrl);

  const matches = (entry: string): boolean => {
    const normalizedEntry = normalizeRepoPath(entry);
    return (
      normalizedRepo.includes(normalizedEntry) ||
      normalizedEntry.includes(normalizedRepo)
    );
  };

  if (check.excludeRepositories && check.excludeRepositories.some(matches)) {
    return false;
  }

  if (check.repositories.length === 0) {
    return true;
  }

  return check.repositories.some(matches);
}

/**
 * Filter checks to those matching the given repository URL/path.
 * Also filters out disabled checks (enabled === false).
 */
export function filterChecksForRepository(
  checks: SecurityCheck[],
  repositoryUrl: string,
): SecurityCheck[] {
  return checks
    .filter((check) => check.enabled !== false)
    .filter((check) => checkMatchesRepository(check, repositoryUrl));
}

// --- Markdown Parsing (spec A.7) ---

/**
 * Parse a markdown check file into CheckDetails.
 * Extracts name from first ### heading, overview from #### Overview section.
 */
export function parseCheckMarkdown(id: string, markdown: string): CheckDetails {
  // Extract name from first ### heading
  const nameMatch = markdown.match(/^###\s+(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : 'Unknown Check';

  // Extract overview from #### Overview section
  let overview = '';
  const overviewMatch = markdown.match(
    /^####\s+Overview\s*\n([\s\S]*?)(?=^####\s|\s*$)/m,
  );
  if (overviewMatch) {
    overview = overviewMatch[1].trim();
  }

  return {
    id,
    name,
    overview,
    content: markdown,
  };
}

/**
 * Load check instructions from the markdown file referenced by a SecurityCheck.
 * Resolves instructionsFile relative to basePath (or uses absolute path if already resolved).
 */
export async function loadCheckDetails(
  check: SecurityCheck,
  basePath: string,
): Promise<CheckDetails> {
  if (!check.instructionsFile) {
    throw new Error(`Check "${check.id}" has no instructionsFile`);
  }
  const instructionsPath = resolve(basePath, check.instructionsFile);
  let markdown: string;
  try {
    markdown = await readFile(instructionsPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to load instructions file "${check.instructionsFile}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (markdown.trim() === '') {
    throw new Error(
      `Instructions file "${check.instructionsFile}" for check "${check.id}" is empty`,
    );
  }

  return parseCheckMarkdown(check.id, markdown);
}

// --- Path Filtering ---
// Note: These path filtering functions are implemented and tested but not yet
// wired into the scan execution path. They will be integrated in a future
// iteration when the agent provider interface supports scoped file lists.

/**
 * Filter files to those matching applicablePaths globs.
 * If applicablePaths is undefined or empty, returns all files.
 */
export function filterApplicablePaths(
  files: string[],
  applicablePaths?: string[],
): string[] {
  if (!applicablePaths || applicablePaths.length === 0) {
    return files;
  }

  const matcher = picomatch(applicablePaths);
  return files.filter((file) => matcher(file));
}

/**
 * Filter out files matching excludedPaths globs.
 * If excludedPaths is undefined or empty, returns all files.
 */
export function filterExcludedPaths(
  files: string[],
  excludedPaths?: string[],
): string[] {
  if (!excludedPaths || excludedPaths.length === 0) {
    return files;
  }

  const matcher = picomatch(excludedPaths);
  return files.filter((file) => !matcher(file));
}

/**
 * Apply both applicablePaths and excludedPaths filtering.
 */
export function filterCheckPaths(
  files: string[],
  check: SecurityCheck,
): string[] {
  const applicable = filterApplicablePaths(files, check.applicablePaths);
  return filterExcludedPaths(applicable, check.excludedPaths);
}
