/**
 * CLI utility for scaffolding new security checks.
 * Creates a check folder with check.json (Layer 2), instructions.md,
 * and optionally rule.yaml + tests/ for Semgrep checks.
 * Appends a registry entry to checks-config.json (Layer 1).
 *
 * Usage:
 *   npx tsx src/new-check.ts                    # Interactive mode
 *   npx tsx src/new-check.ts --id aghast-xss    # Mixed mode (prompts for missing)
 *   npx tsx src/new-check.ts --id ... --name ... # Full flag mode (no prompts)
 */

import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createRequire } from 'node:module';
import { ERROR_CODES, formatError, formatFatalError } from './error-codes.js';
import { getCheckType, getValidCheckTypes } from './check-types.js';
import { DEFAULT_MODEL } from './types.js';
import { docsFooter } from './docs-url.js';

const ID_PREFIX = 'aghast-';

// --- Supported Languages (easy to extend) ---

interface LanguageInfo {
  semgrepId: string;
  extension: string;
  commentPrefix: string;
}

const SUPPORTED_LANGUAGES: Record<string, LanguageInfo> = {
  python: { semgrepId: 'python', extension: '.py', commentPrefix: '#' },
  py: { semgrepId: 'python', extension: '.py', commentPrefix: '#' },
  javascript: { semgrepId: 'javascript', extension: '.js', commentPrefix: '//' },
  js: { semgrepId: 'javascript', extension: '.js', commentPrefix: '//' },
  typescript: { semgrepId: 'typescript', extension: '.ts', commentPrefix: '//' },
  ts: { semgrepId: 'typescript', extension: '.ts', commentPrefix: '//' },
};

// Canonical names for display in prompts
const LANGUAGE_CHOICES = ['python', 'javascript', 'typescript'];

// --- Arg Parsing ---

interface ParsedFlags {
  id?: string;
  name?: string;
  severity?: string;
  confidence?: string;
  model?: string;
  repositories?: string;
  checkOverview?: string;
  checkItems?: string;
  passCondition?: string;
  failCondition?: string;
  flagCondition?: string;
  checkType?: string;
  discovery?: string;
  semgrepRules?: string;
  sarifFile?: string;
  glob?: string;
  analysisMode?: string;
  maxTargets?: string;
  language?: string;
  script?: string;
  scriptType?: string;
  outputFormat?: string;
  cwd?: string;
  timeoutMs?: string;
  priority?: string;
  matchFileTypes?: string;
  matchPaths?: string;
  matchFiles?: string;
  matchTags?: string;
  configDir?: string;
}

const CLI_FLAG_MAP: Record<string, keyof ParsedFlags> = {
  '--id': 'id',
  '--name': 'name',
  '--severity': 'severity',
  '--confidence': 'confidence',
  '--model': 'model',
  '--repositories': 'repositories',
  '--check-overview': 'checkOverview',
  '--check-items': 'checkItems',
  '--pass-condition': 'passCondition',
  '--fail-condition': 'failCondition',
  '--flag-condition': 'flagCondition',
  '--check-type': 'checkType',
  '--discovery': 'discovery',
  '--semgrep-rules': 'semgrepRules',
  '--opengrep-rules': 'semgrepRules',
  '--sarif-file': 'sarifFile',
  '--glob': 'glob',
  '--analysis-mode': 'analysisMode',
  '--max-targets': 'maxTargets',
  '--language': 'language',
  '--script': 'script',
  '--script-type': 'scriptType',
  '--output-format': 'outputFormat',
  '--cwd': 'cwd',
  '--timeout-ms': 'timeoutMs',
  '--priority': 'priority',
  '--match-file-types': 'matchFileTypes',
  '--match-paths': 'matchPaths',
  '--match-files': 'matchFiles',
  '--match-tags': 'matchTags',
  '--config-dir': 'configDir',
};

function parseFlags(args: string[]): ParsedFlags {
  if (args.includes('--semgrep-rules') && args.includes('--opengrep-rules')) {
    console.error(formatError(
      ERROR_CODES.E1001,
      '--semgrep-rules and --opengrep-rules are aliases for the same option; pass only one',
    ));
    process.exit(1);
  }
  const flags: ParsedFlags = {};
  for (let i = 0; i < args.length; i++) {
    const key = CLI_FLAG_MAP[args[i]];
    if (key) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(formatError(ERROR_CODES.E1001, `${args[i]} requires a value`));
        process.exit(1);
      }
      flags[key] = value;
      i++; // skip value
    }
  }
  return flags;
}

// --- Interactive Prompts ---

async function promptForMissing(flags: ParsedFlags): Promise<Required<Omit<ParsedFlags, 'configDir'>>> {
  const needsPrompt =
    !flags.id || !flags.name || !flags.checkType;

  let rl: ReturnType<typeof createInterface> | undefined;
  if (needsPrompt) {
    rl = createInterface({ input: stdin, output: stdout });
  }

  async function ask(label: string, existing?: string): Promise<string> {
    if (existing !== undefined) return existing;
    if (!rl) throw new Error('Unexpected: readline not initialized');
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const answer = await rl.question(`${label}: `);
      if (answer.trim()) return answer.trim();
      const remaining = maxAttempts - attempt;
      if (remaining > 0) {
        console.error(formatError(ERROR_CODES.E1003, `${label} is required (${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining)`));
      }
    }
    console.error(formatError(ERROR_CODES.E1003, `${label} is required — no valid input after ${maxAttempts} attempts`));
    rl.close();
    process.exit(1);
  }

  async function askOptional(label: string, existing?: string): Promise<string> {
    if (existing !== undefined) return existing;
    if (!rl) return '';
    const answer = await rl.question(`${label} (optional, press Enter to skip): `);
    return answer.trim();
  }

  async function askChoice(label: string, choices: string[], defaultValue: string, existing?: string): Promise<string> {
    if (existing !== undefined) return existing;
    if (!rl) return defaultValue;
    const numbered = choices.map((c, i) => `  ${i + 1}) ${c}${c === defaultValue ? ' (default)' : ''}`).join('\n');
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const answer = await rl.question(`${label}:\n${numbered}\nChoice: `);
      const trimmed = answer.trim();
      if (!trimmed) return defaultValue;
      // Accept by number or by name
      const byNumber = parseInt(trimmed, 10);
      if (!isNaN(byNumber) && byNumber >= 1 && byNumber <= choices.length) return choices[byNumber - 1];
      if (choices.includes(trimmed)) return trimmed;
      const remaining = maxAttempts - attempt;
      if (remaining > 0) {
        console.error(`Invalid choice "${trimmed}". Enter a number (1-${choices.length}) or name. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`);
      }
    }
    console.error(formatError(ERROR_CODES.E1003, `${label} — no valid choice after ${maxAttempts} attempts`));
    rl.close();
    process.exit(1);
  }

  // Yes/no gate. Defaults to "no" on empty input. Non-interactive callers never
  // reach this (they gate on whether flags were supplied instead).
  async function askYesNo(label: string): Promise<boolean> {
    if (!rl) return false;
    const answer = await rl.question(`${label} (y/N): `);
    return /^y(es)?$/i.test(answer.trim());
  }

  // Phase 1: Basic identity
  const result = {
    id: await ask('Check ID (e.g. aghast-xss)', flags.id),
    name: await ask('Check name (e.g. XSS Prevention)', flags.name),
    severity: '',
    confidence: '',
    model: '',
    repositories: '',
    checkOverview: '',
    checkItems: '',
    passCondition: '',
    failCondition: '',
    flagCondition: '',
    checkType: '',
    discovery: '',
    analysisMode: '',
    semgrepRules: '',
    sarifFile: '',
    glob: '',
    maxTargets: '',
    language: '',
    script: '',
    scriptType: '',
    outputFormat: '',
    cwd: '',
    timeoutMs: '',
    priority: '',
    matchFileTypes: '',
    matchPaths: '',
    matchFiles: '',
    matchTags: '',
  };

  // Phase 2: Check type, discovery, and analysis mode (determines what other questions to ask)
  result.checkType = await askChoice('Check type', getValidCheckTypes(), 'targeted', flags.checkType);

  if (result.checkType === 'targeted' || result.checkType === 'static') {
    const discoveryChoices = result.checkType === 'targeted'
      ? ['semgrep', 'opengrep', 'openant', 'sarif', 'glob', 'script']
      : ['semgrep', 'opengrep'];
    result.discovery = await askChoice('Discovery method', discoveryChoices, 'semgrep', flags.discovery);
    result.maxTargets = await askOptional('Max targets', flags.maxTargets);

    if (result.checkType === 'targeted') {
      let modeChoices: string[];
      if (result.discovery === 'openant') {
        modeChoices = ['custom', 'general-vuln-discovery'];
      } else if (result.discovery === 'glob' || result.discovery === 'script') {
        // glob/script discovery do not support false-positive-validation (no
        // per-target tool finding to validate); offer custom and
        // general-vuln-discovery.
        modeChoices = ['custom', 'general-vuln-discovery'];
      } else {
        modeChoices = ['custom', 'false-positive-validation', 'general-vuln-discovery'];
      }
      result.analysisMode = await askChoice('Analysis mode', modeChoices, 'custom', flags.analysisMode);
    }

    if (result.discovery === 'semgrep' || result.discovery === 'opengrep') {
      const toolLabel = result.discovery === 'opengrep' ? 'Opengrep' : 'Semgrep';
      result.semgrepRules = flags.semgrepRules !== undefined
        ? flags.semgrepRules
        : await askOptional(`${toolLabel} rule file paths (comma-separated, or press Enter to generate template)`, undefined);
      if (!result.semgrepRules) {
        result.language = await askChoice('Language', LANGUAGE_CHOICES, 'javascript', flags.language);
      } else {
        result.language = flags.language ?? '';
      }
    } else if (result.discovery === 'sarif') {
      result.sarifFile = flags.sarifFile !== undefined
        ? flags.sarifFile
        : await ask('SARIF file path (relative to target repo, e.g. ./sast-results.sarif)', flags.sarifFile);
    } else if (result.discovery === 'glob') {
      result.glob = flags.glob !== undefined
        ? flags.glob
        : await ask('Glob pattern (e.g. src/routes/**/*.ts)', flags.glob);
    } else if (result.discovery === 'script') {
      result.scriptType = await askChoice('Script runtime', ['node', 'bash'], 'node', flags.scriptType);
      result.outputFormat = await askChoice(
        'Script output format', ['lines', 'json-array', 'json-object'], 'json-array', flags.outputFormat,
      );
      // Empty script path means "generate a starter script" (mirrors the
      // semgrep-rules empty→template behaviour above).
      result.script = flags.script !== undefined
        ? flags.script
        : await askOptional('Script file path (relative to check folder, or Enter to generate a starter script)', undefined);
      result.cwd = await askOptional('Working directory (relative to repo root, default: repo root)', flags.cwd);
      result.timeoutMs = await askOptional('Script timeout in ms (default: 30000)', flags.timeoutMs);
    }
  }

  // Phase 3: Severity, confidence, model, repositories
  result.severity = await askChoice('Severity', ['critical', 'high', 'medium', 'low', 'informational'], 'high', flags.severity);
  result.confidence = await askChoice('Confidence', ['high', 'medium', 'low'], 'medium', flags.confidence);
  result.model = flags.model !== undefined ? flags.model : await askOptional(`AI model override (default: ${DEFAULT_MODEL})`, undefined);
  result.repositories = flags.repositories !== undefined ? flags.repositories : await askOptional('Repositories (comma-separated URLs, or empty for all)', undefined);

  // Phase 3.5: Registry-level fields (Layer 1) — execution ordering and dynamic
  // repository matching. Apply to every check type.
  result.priority = flags.priority !== undefined
    ? flags.priority
    : await askOptional('Execution priority (non-negative integer, lower runs first)', undefined);

  const matchFlagsProvided =
    flags.matchFileTypes !== undefined || flags.matchPaths !== undefined ||
    flags.matchFiles !== undefined || flags.matchTags !== undefined;
  if (matchFlagsProvided) {
    // Non-interactive / flag-driven: take whatever flags were supplied.
    result.matchFileTypes = flags.matchFileTypes ?? '';
    result.matchPaths = flags.matchPaths ?? '';
    result.matchFiles = flags.matchFiles ?? '';
    result.matchTags = flags.matchTags ?? '';
  } else if (await askYesNo('Add repository match criteria?')) {
    // Interactive gate said yes — prompt for each sub-field.
    result.matchFileTypes = await askOptional('  Match file types (comma-separated extensions, e.g. .ts,.tsx)', undefined);
    result.matchPaths = await askOptional('  Match paths (comma-separated glob patterns; any match)', undefined);
    result.matchFiles = await askOptional('  Require files (comma-separated paths/globs; all must exist)', undefined);
    result.matchTags = await askOptional('  Require tags (comma-separated; all must be present)', undefined);
  }

  // Phase 4: Instructions (only for check types/modes that need custom instructions)
  const builtInAnalysisMode = result.analysisMode === 'false-positive-validation'
    || result.analysisMode === 'general-vuln-discovery';
  const needsCustomInstructions = getCheckType(result.checkType).needsInstructions && !builtInAnalysisMode;

  if (needsCustomInstructions) {
    result.checkOverview = await ask('Check overview / description', flags.checkOverview);
    result.checkItems = await ask('Check items (comma-separated)', flags.checkItems);
    result.passCondition = await ask('PASS condition', flags.passCondition);
    result.failCondition = await ask('FAIL condition', flags.failCondition);
    result.flagCondition = await askOptional('FLAG condition (requires human investigation)', flags.flagCondition);
  }

  if (rl) rl.close();
  return result;
}

// --- ID Prefix ---

function ensurePrefix(id: string): string {
  if (id.startsWith(ID_PREFIX)) return id;
  return ID_PREFIX + id;
}

// --- Validation ---

interface RegistryFile {
  checks: Array<{ id: string; [key: string]: unknown }>;
}

async function loadExistingRegistry(registryPath: string): Promise<RegistryFile> {
  const raw = await readFile(registryPath, 'utf-8');
  return JSON.parse(raw) as RegistryFile;
}

function validateInputs(
  inputs: { id: string; severity: string; confidence: string; checkType: string; discovery: string; analysisMode: string; maxTargets: string; language: string; sarifFile: string; glob: string; scriptType: string; outputFormat: string; timeoutMs: string; priority: string; matchFileTypes: string; matchPaths: string; matchFiles: string; matchTags: string },
): string[] {
  const errors: string[] = [];

  if (!inputs.id) {
    errors.push('Check ID is required');
  }

  const validSeverities = ['critical', 'high', 'medium', 'low', 'informational'];
  if (inputs.severity && !validSeverities.includes(inputs.severity)) {
    errors.push(`Invalid severity "${inputs.severity}". Must be one of: ${validSeverities.join(', ')}`);
  }

  const validConfidences = ['high', 'medium', 'low'];
  if (inputs.confidence && !validConfidences.includes(inputs.confidence)) {
    errors.push(`Invalid confidence "${inputs.confidence}". Must be one of: ${validConfidences.join(', ')}`);
  }

  const validCheckTypes = getValidCheckTypes();
  if (inputs.checkType && !validCheckTypes.includes(inputs.checkType)) {
    errors.push(`Invalid check type "${inputs.checkType}". Must be one of: ${validCheckTypes.join(', ')}`);
  }

  if (inputs.maxTargets) {
    const parsed = parseInt(inputs.maxTargets, 10);
    if (isNaN(parsed) || parsed <= 0) {
      errors.push(`Invalid maxTargets "${inputs.maxTargets}". Must be a positive integer`);
    }
  }

  if (inputs.timeoutMs) {
    const parsed = parseInt(inputs.timeoutMs, 10);
    if (isNaN(parsed) || parsed <= 0) {
      errors.push(`Invalid timeoutMs "${inputs.timeoutMs}". Must be a positive integer`);
    }
  }

  if (inputs.priority) {
    const parsed = parseInt(inputs.priority, 10);
    if (isNaN(parsed) || parsed < 0 || String(parsed) !== inputs.priority.trim()) {
      errors.push(`Invalid priority "${inputs.priority}". Must be a non-negative integer`);
    }
  }

  // A blank/whitespace/comma-only match-* value would otherwise scaffold an
  // empty-array matchCriteria sub-field, which fails loadCheckRegistry's
  // "at least one of ..." check for the *whole* registry, not just this
  // check. Reject it here instead, at scaffold time.
  const matchFieldChecks: Array<[label: string, raw: string, split: string[]]> = [
    ['--match-file-types', inputs.matchFileTypes, splitList(inputs.matchFileTypes)],
    ['--match-paths', inputs.matchPaths, splitGlobList(inputs.matchPaths)],
    ['--match-files', inputs.matchFiles, splitGlobList(inputs.matchFiles)],
    ['--match-tags', inputs.matchTags, splitList(inputs.matchTags)],
  ];
  for (const [label, raw, split] of matchFieldChecks) {
    if (raw && split.length === 0) {
      errors.push(`${label} "${raw}" contains no usable values after parsing; provide at least one non-empty, comma-separated value or omit the flag`);
    }
  }

  if ((inputs.checkType === 'targeted' || inputs.checkType === 'static') && inputs.checkType) {
    const validDiscoveries = inputs.checkType === 'targeted'
      ? ['semgrep', 'opengrep', 'openant', 'sarif', 'glob', 'script']
      : ['semgrep', 'opengrep'];
    if (!inputs.discovery || !validDiscoveries.includes(inputs.discovery)) {
      errors.push(`Invalid discovery "${inputs.discovery}" for check type "${inputs.checkType}". Must be one of: ${validDiscoveries.join(', ')}`);
    }
    if (inputs.discovery === 'sarif' && !inputs.sarifFile) {
      errors.push('sarifFile is required for sarif discovery');
    }
    if (inputs.discovery === 'glob' && !inputs.glob) {
      errors.push('glob pattern is required for glob discovery');
    }
    if (inputs.discovery === 'script') {
      const validScriptTypes = ['node', 'bash'];
      if (!inputs.scriptType || !validScriptTypes.includes(inputs.scriptType)) {
        errors.push(`Invalid scriptType "${inputs.scriptType}" for script discovery. Must be one of: ${validScriptTypes.join(', ')}`);
      }
      const validOutputFormats = ['lines', 'json-array', 'json-object'];
      if (!inputs.outputFormat || !validOutputFormats.includes(inputs.outputFormat)) {
        errors.push(`Invalid outputFormat "${inputs.outputFormat}" for script discovery. Must be one of: ${validOutputFormats.join(', ')}`);
      }
    }

    if (inputs.analysisMode) {
      let validModes: string[];
      if (inputs.discovery === 'openant' || inputs.discovery === 'glob' || inputs.discovery === 'script') {
        validModes = ['custom', 'general-vuln-discovery'];
      } else {
        validModes = ['custom', 'false-positive-validation', 'general-vuln-discovery'];
      }
      if (!validModes.includes(inputs.analysisMode)) {
        errors.push(`Invalid analysis mode "${inputs.analysisMode}" for ${inputs.discovery} discovery. Must be one of: ${validModes.join(', ')}`);
      }
    }
  }

  if ((inputs.discovery === 'semgrep' || inputs.discovery === 'opengrep') && inputs.language && !SUPPORTED_LANGUAGES[inputs.language]) {
    errors.push(`Invalid language "${inputs.language}". Must be one of: ${Object.keys(SUPPORTED_LANGUAGES).join(', ')}`);
  }

  return errors;
}

async function checkFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// --- Semgrep Rule Template ---

function generateSemgrepRule(checkId: string, language: string): string {
  const langInfo = SUPPORTED_LANGUAGES[language];
  const semgrepLang = langInfo ? langInfo.semgrepId : 'javascript';
  return `rules:
  - id: ${checkId}
    pattern: |
      # TODO: Replace with your pattern (Semgrep/Opengrep syntax)
      ...
    message: >
      TODO: Describe the issue this rule detects.
    languages: [${semgrepLang}]
    severity: WARNING
`;
}

function generateSemgrepTestFile(checkId: string, language: string): string {
  const langInfo = SUPPORTED_LANGUAGES[language];
  const comment = langInfo ? langInfo.commentPrefix : '#';
  return `${comment} ruleid: ${checkId}
${comment} TODO: Add code that SHOULD be matched by the rule

${comment} ok: ${checkId}
${comment} TODO: Add code that should NOT be matched by the rule
`;
}

// --- Script Discovery Template ---

/** File extension for a generated starter discovery script. */
function scriptExtension(scriptType: string): string {
  return scriptType === 'bash' ? '.sh' : '.js';
}

/**
 * Generate a starter discovery script for `script` discovery. The body matches
 * the chosen `outputFormat` and the output contract is documented in comments
 * (see docs/configuration.md#script-discovery).
 */
function generateDiscoveryScript(
  checkId: string,
  scriptType: 'node' | 'bash',
  outputFormat: 'lines' | 'json-array' | 'json-object',
): string {
  if (scriptType === 'bash') {
    // Runs in the target repo (cwd = repo root by default). Print targets to
    // stdout; write diagnostics to stderr. A non-zero exit fails the check.
    const header = `#!/usr/bin/env bash
# Discovery script for ${checkId}.
# Runs inside the target repo (cwd = repo root by default).
# Output contract: print discovery targets to stdout in the "${outputFormat}" format.
#   - Only the "file" field is required; it must be a repo-relative path that
#     stays inside the repo (no absolute paths, no ".." escape).
#   - Optional fields: startLine, endLine, message, snippet.
# Write diagnostics to stderr. A non-zero exit status fails the check.
# The environment is curated: API keys/tokens are NOT available to this script.
set -euo pipefail
`;
    if (outputFormat === 'lines') {
      return `${header}
# TODO: replace with real discovery logic — one repo-relative file path per line.
# printf '%s\\n' 'src/example.ts'
`;
    }
    if (outputFormat === 'json-object') {
      return `${header}
# TODO: replace with real discovery logic — emit a JSON object with a "targets" array.
echo '{ "targets": [] }'
`;
    }
    return `${header}
# TODO: replace with real discovery logic — emit a JSON array of target objects.
# echo '[{ "file": "src/example.ts", "startLine": 1, "endLine": 20, "message": "example target" }]'
echo '[]'
`;
  }

  // node
  const header = `#!/usr/bin/env node
// Discovery script for ${checkId}.
// Runs inside the target repo (cwd = repo root by default).
// Output contract: print discovery targets to stdout in the "${outputFormat}" format.
//   - Only the "file" field is required; it must be a repo-relative path that
//     stays inside the repo (no absolute paths, no ".." escape).
//   - Optional fields: startLine, endLine, message, snippet.
// Write diagnostics to stderr (console.error). A non-zero exit fails the check.
// The environment is curated: API keys/tokens are NOT available to this script.
`;
  if (outputFormat === 'lines') {
    return `${header}
// TODO: replace with real discovery logic — one repo-relative file path per line.
const files = [
  // 'src/example.ts',
];
process.stdout.write(files.join('\\n'));
`;
  }
  if (outputFormat === 'json-object') {
    return `${header}
// TODO: replace with real discovery logic.
const targets = [
  // { file: 'src/example.ts', startLine: 1, endLine: 20, message: 'example target' },
];
process.stdout.write(JSON.stringify({ targets }));
`;
  }
  return `${header}
// TODO: replace with real discovery logic.
const targets = [
  // { file: 'src/example.ts', startLine: 1, endLine: 20, message: 'example target' },
];
process.stdout.write(JSON.stringify(targets));
`;
}

// --- File Generation ---

function generateMarkdown(inputs: {
  name: string;
  checkOverview: string;
  checkItems: string;
  passCondition: string;
  failCondition: string;
  flagCondition: string;
}): string {
  const items = inputs.checkItems
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const itemLines = items.map((item, i) => `${i + 1}. ${item}`).join('\n');

  let resultLines = `- **PASS**: ${inputs.passCondition}\n- **FAIL**: ${inputs.failCondition}`;
  if (inputs.flagCondition) {
    resultLines += `\n- **FLAG**: ${inputs.flagCondition}`;
  }

  return `### ${inputs.name}

#### Overview
${inputs.checkOverview}

#### What to Check
${itemLines}

#### Result
${resultLines}
`;
}

function generateCheckDefinition(inputs: {
  id: string;
  name: string;
  severity: string;
  confidence: string;
  model: string;
  checkType: string;
  discovery: string;
  analysisMode: string;
  semgrepRules: string;
  sarifFile: string;
  glob: string;
  script: string;
  scriptType: string;
  outputFormat: string;
  cwd: string;
  timeoutMs: string;
  maxTargets: string;
}): Record<string, unknown> {
  const def: Record<string, unknown> = {
    id: inputs.id,
    name: inputs.name,
  };

  // Only check types that need instructions get an instructionsFile.
  // Built-in analysis modes provide their own prompt — no instructionsFile needed.
  const builtInMode = inputs.analysisMode === 'false-positive-validation'
    || inputs.analysisMode === 'general-vuln-discovery';
  if (getCheckType(inputs.checkType).needsInstructions && !builtInMode) {
    def.instructionsFile = `${inputs.id}.md`;
  }

  if (inputs.severity) {
    def.severity = inputs.severity;
  }
  if (inputs.confidence) {
    def.confidence = inputs.confidence;
  }
  if (inputs.model) {
    def.model = inputs.model;
  }

  if (inputs.checkType === 'targeted' || inputs.checkType === 'static') {
    const checkTarget: Record<string, unknown> = {
      type: inputs.checkType,
      discovery: inputs.discovery,
    };
    if (inputs.discovery === 'semgrep' || inputs.discovery === 'opengrep') {
      if (inputs.semgrepRules) {
        const rules = inputs.semgrepRules.split(',').map((r) => r.trim()).filter(Boolean);
        checkTarget.rules = rules.length === 1 ? rules[0] : rules;
      } else {
        checkTarget.rules = `${inputs.id}.yaml`;
      }
    } else if (inputs.discovery === 'sarif') {
      checkTarget.sarifFile = inputs.sarifFile;
    } else if (inputs.discovery === 'glob') {
      checkTarget.glob = inputs.glob;
    } else if (inputs.discovery === 'script') {
      // When no explicit script path is given, a starter script named after the
      // check id + runtime extension is generated (see runNewCheck).
      const scriptType = (inputs.scriptType || 'node') as 'node' | 'bash';
      checkTarget.script = inputs.script || `${inputs.id}${scriptExtension(scriptType)}`;
      checkTarget.scriptType = scriptType;
      checkTarget.outputFormat = inputs.outputFormat || 'json-array';
      if (inputs.cwd) {
        checkTarget.cwd = inputs.cwd;
      }
      if (inputs.timeoutMs) {
        checkTarget.timeoutMs = parseInt(inputs.timeoutMs, 10);
      }
    }
    if (inputs.analysisMode && inputs.analysisMode !== 'custom') {
      checkTarget.analysisMode = inputs.analysisMode;
    }
    if (inputs.maxTargets) {
      checkTarget.maxTargets = parseInt(inputs.maxTargets, 10);
    }
    def.checkTarget = checkTarget;
  }

  return def;
}

/** Split a comma-separated flag value into a trimmed, non-empty list. */
function splitList(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * Split a comma-separated list of glob patterns, brace-aware: commas inside
 * `{...}` brace-expansion groups (e.g. `src/**\/*.{ts,tsx}`) are not treated
 * as list separators, so a single pattern using brace expansion survives
 * intact instead of being torn into two malformed patterns. Otherwise
 * behaves like splitList (trims and drops empty segments).
 */
function splitGlobList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((v) => v.trim()).filter(Boolean);
}

function generateRegistryEntry(inputs: {
  id: string;
  repositories: string;
  priority: string;
  matchFileTypes: string;
  matchPaths: string;
  matchFiles: string;
  matchTags: string;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: inputs.id,
    repositories: inputs.repositories ? splitList(inputs.repositories) : [],
    enabled: true,
  };

  if (inputs.priority) {
    entry.priority = parseInt(inputs.priority, 10);
  }

  // matchCriteria (Layer 1) — include only the sub-fields that produced at
  // least one item after splitting (a blank/whitespace/comma-only value must
  // not scaffold an empty array — see validateInputs, which rejects that
  // case before we get here).
  const matchCriteria: Record<string, string[]> = {};
  const fileTypes = splitList(inputs.matchFileTypes);
  const paths = splitGlobList(inputs.matchPaths);
  const files = splitGlobList(inputs.matchFiles);
  const tags = splitList(inputs.matchTags);
  if (fileTypes.length > 0) matchCriteria.hasFileTypes = fileTypes;
  if (paths.length > 0) matchCriteria.hasPaths = paths;
  if (files.length > 0) matchCriteria.hasFiles = files;
  if (tags.length > 0) matchCriteria.tags = tags;
  if (Object.keys(matchCriteria).length > 0) {
    entry.matchCriteria = matchCriteria;
  }

  return entry;
}

// --- Main ---

const NEW_CHECK_HELP = `Usage: aghast new-check --config-dir <path> [options]

Scaffold a new security check. Runs interactively by default, prompting for any
values not provided via flags. If the config directory does not exist, it will be
created with an empty checks-config.json.

Options:
  --config-dir <path>        Config directory containing checks-config.json and
                             checks/ folder. Created if it does not exist.
                             Required unless AGHAST_CONFIG_DIR is set.
  --id <id>                  Check ID (will be prefixed with "aghast-" if needed)
  --name <name>              Human-readable check name (e.g. "XSS Prevention")
  --severity <level>         Severity: critical, high, medium, low, informational
  --confidence <level>       Confidence: high, medium, low
  --model <model>            AI model override for this check (e.g. claude-sonnet-4-6)
  --repositories <urls>      Comma-separated repository URLs (empty = all repos)
  --check-overview <text>    Description of what this check does
  --check-items <items>      Comma-separated list of things to check
  --pass-condition <text>    Condition for a PASS result
  --fail-condition <text>    Condition for a FAIL result
  --flag-condition <text>    Condition for a FLAG result (optional)
  --check-type <type>        Check type (default: targeted). See 'Check types' below
  --discovery <name>         Discovery mechanism for targeted/static checks. See below
  --semgrep-rules <paths>    Comma-separated rule file paths (for semgrep/opengrep discovery)
  --opengrep-rules <paths>   Alias for --semgrep-rules; do not pass both (error)
  --sarif-file <path>        SARIF file path in check definition, relative to repo (for sarif discovery)
  --glob <pattern>           Glob pattern (for glob discovery, e.g. "src/routes/**/*.ts")
  --script <path>            Script path relative to the check folder (for script
                             discovery; omit to generate a starter script)
  --script-type <type>       Script runtime: node or bash (for script discovery)
  --output-format <format>   Script stdout format: lines, json-array, json-object
  --cwd <path>               Working directory for the script, relative to repo root
  --timeout-ms <n>           Script timeout in milliseconds (default: 30000)
  --analysis-mode <mode>     Analysis mode for targeted checks (default: custom). See below
  --max-targets <n>          Maximum number of targets to analyze
  --language <lang>          Language for Semgrep/Opengrep template: python, javascript, typescript
  --priority <n>             Execution order (non-negative integer, lower runs first)
  --match-file-types <exts>  matchCriteria: comma-separated file extensions (e.g. .ts,.tsx)
  --match-paths <globs>      matchCriteria: comma-separated glob patterns (any match)
  --match-files <paths>      matchCriteria: comma-separated paths/globs (all must exist)
  --match-tags <tags>        matchCriteria: comma-separated repo tags (all must be present)
  -h, --help                 Show this help message

Environment variables:
  AGHAST_CONFIG_DIR           Default config directory (CLI --config-dir takes precedence)

Check types:
  repository  AI analyzes the whole repository
  targeted    Discovery finds specific targets, AI analyzes each one
  static      Discovery finds targets, mapped directly to issues (no AI)

Discovery mechanisms:
  semgrep     Semgrep rules find targets (targeted or static)
  opengrep    Opengrep (Semgrep fork) rules find targets (targeted or static)
  openant     OpenAnt code analysis finds units (targeted only)
  sarif       External SARIF file provides findings (targeted only)
  glob        File path glob pattern selects whole-file targets (targeted only)
  script      User-provided node/bash script emits targets (targeted only)

Analysis modes (targeted checks only):
  custom                      Use a custom instructions markdown file (default)
  false-positive-validation   AI validates each finding as true/false positive (semgrep, opengrep, sarif)
  general-vuln-discovery      AI scans each target for general security vulnerabilities (all)

Repository matching / ordering (registry-level, all check types):
  --priority                  Lower values run first; unset checks run last
  --match-*                   Add repos dynamically via matchCriteria in addition to
                              the explicit --repositories list

Examples:
  aghast new-check --config-dir ./my-checks
  aghast new-check --config-dir ./my-checks --id xss --name "XSS Prevention"
  aghast new-check --config-dir ./my-checks --check-type targeted --discovery semgrep --language typescript
  aghast new-check --config-dir ./my-checks --check-type targeted --discovery sarif --sarif-file ./sast-results.sarif
  aghast new-check --config-dir ./my-checks --check-type targeted --discovery script --script-type node --output-format json-array

${docsFooter('creating-checks.md')}`;

export async function runNewCheck(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(NEW_CHECK_HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);

  // --config-dir is required (CLI flag > AGHAST_CONFIG_DIR env var)
  const rawConfigDir = flags.configDir || process.env.AGHAST_CONFIG_DIR;
  if (!rawConfigDir) {
    console.error(formatError(ERROR_CODES.E2001, '--config-dir is required (or set AGHAST_CONFIG_DIR).'));
    process.exit(1);
  }

  const configDir = resolve(rawConfigDir);
  const checksDir = resolve(configDir, 'checks');
  const registryPath = resolve(configDir, 'checks-config.json');

  const inputs = await promptForMissing(flags);

  // Ensure aghast- prefix
  inputs.id = ensurePrefix(inputs.id);

  // Bootstrap: create checks-config.json if it doesn't exist
  let registry: RegistryFile;
  if (await checkFileExists(registryPath)) {
    registry = await loadExistingRegistry(registryPath);
  } else {
    await mkdir(configDir, { recursive: true });
    const emptyRegistry: RegistryFile = { checks: [] };
    await writeFile(registryPath, JSON.stringify(emptyRegistry, null, 2) + '\n', 'utf-8');
    console.log(`Created new config: ${registryPath}`);
    registry = emptyRegistry;
  }

  const validationErrors = validateInputs(inputs);
  if (validationErrors.length > 0) {
    for (const err of validationErrors) {
      console.error(formatError(ERROR_CODES.E2004, err));
    }
    process.exit(1);
  }

  // Script discovery with scriptType "bash" can never run on Windows
  // (E7106) — warn now, at scaffold time, rather than let the author
  // discover it only after a failed scan.
  if (inputs.discovery === 'script' && (inputs.scriptType || 'node') === 'bash' && process.platform === 'win32') {
    console.warn(
      `Warning: --script-type bash is not supported on Windows (${ERROR_CODES.E7106.code}); this check will fail at scan time on this machine. Use --script-type node, or run scans from Linux/macOS/WSL.`,
    );
  }

  // Create check folder
  const checkFolder = resolve(checksDir, inputs.id);
  if (await checkFileExists(checkFolder)) {
    console.error(formatError(ERROR_CODES.E2004, `Check folder already exists: ${checkFolder}`));
    process.exit(1);
  }

  const isAlreadyRegistered = registry.checks.some((check) => check.id === inputs.id);
  if (isAlreadyRegistered) {
    console.warn(
      `Check ID "${inputs.id}" already exists in checks-config.json; creating the missing check files without changing its registry entry.`,
    );
  }

  await mkdir(checkFolder, { recursive: true });

  // Generate and write check.json (Layer 2)
  const checkDef = generateCheckDefinition(inputs);
  await writeFile(resolve(checkFolder, `${inputs.id}.json`), JSON.stringify(checkDef, null, 2) + '\n', 'utf-8');
  console.log(`Created: ${checkFolder}/${inputs.id}.json`);

  // Generate and write instructions.md (only when instructions are needed)
  const builtInAnalysisMode = inputs.analysisMode === 'false-positive-validation'
    || inputs.analysisMode === 'general-vuln-discovery';
  if (getCheckType(inputs.checkType).needsInstructions && !builtInAnalysisMode) {
    const markdown = generateMarkdown(inputs);
    await writeFile(resolve(checkFolder, `${inputs.id}.md`), markdown, 'utf-8');
    console.log(`Created: ${checkFolder}/${inputs.id}.md`);
  }

  // Generate Semgrep/Opengrep rule template and test file if needed
  // (the rule file format is identical between the two tools)
  if ((inputs.discovery === 'semgrep' || inputs.discovery === 'opengrep') && !inputs.semgrepRules) {
    const rulePath = resolve(checkFolder, `${inputs.id}.yaml`);
    await writeFile(rulePath, generateSemgrepRule(inputs.id, inputs.language), 'utf-8');
    console.log(`Created: ${checkFolder}/${inputs.id}.yaml (template — edit before running)`);

    // Create corresponding test file
    const langInfo = SUPPORTED_LANGUAGES[inputs.language];
    if (langInfo) {
      const testsDir = resolve(checkFolder, 'tests');
      await mkdir(testsDir, { recursive: true });
      const testFileName = `${inputs.id}${langInfo.extension}`;
      const testPath = resolve(testsDir, testFileName);
      await writeFile(testPath, generateSemgrepTestFile(inputs.id, inputs.language), 'utf-8');
      console.log(`Created: ${checkFolder}/tests/${testFileName} (test scaffold — edit before running)`);
    }
  }

  // Generate a starter discovery script when the author didn't supply their own.
  if (inputs.discovery === 'script' && !inputs.script) {
    const scriptType = (inputs.scriptType || 'node') as 'node' | 'bash';
    const outputFormat = (inputs.outputFormat || 'json-array') as 'lines' | 'json-array' | 'json-object';
    const scriptName = `${inputs.id}${scriptExtension(scriptType)}`;
    const scriptPath = resolve(checkFolder, scriptName);
    await writeFile(scriptPath, generateDiscoveryScript(inputs.id, scriptType, outputFormat), 'utf-8');
    console.log(`Created: ${checkFolder}/${scriptName} (starter script — edit before running)`);
  }

  // Update registry (Layer 1)
  if (!isAlreadyRegistered) {
    const registryEntry = generateRegistryEntry(inputs);
    registry.checks.push(registryEntry as RegistryFile['checks'][number]);
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
    console.log(`Updated: ${registryPath}`);
  }

  console.log(`\nNew check "${inputs.id}" created successfully.`);
}

// Auto-run when executed directly (npm run new-check / tsx src/new-check.ts), but not when imported by cli.ts.
if (!process.env._AGHAST_CLI) {
  await import('dotenv/config');
  runNewCheck(process.argv.slice(2)).catch((err) => {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    console.error('');
    console.error(formatFatalError(err instanceof Error ? err.message : String(err), pkg.version));
    process.exit(1);
  });
}
