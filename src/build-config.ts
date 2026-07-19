/**
 * CLI utility for building / editing a runtime-config.json file.
 *
 * Interactive by default; flag-only mode skips prompts. If a config file
 * already exists, its values are loaded and used as defaults — only the
 * fields you change (or pass as flags) are updated.
 *
 * Usage:
 *   aghast build-config --config-dir <path>          # interactive, file at <path>/runtime-config.json
 *   aghast build-config --runtime-config <file>      # interactive, write to explicit file
 *   aghast build-config --config-dir <path> --provider claude-code --model sonnet  # non-interactive
 *   aghast build-config --config-dir <path> --non-interactive  # accept all current/defaults
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createRequire } from 'node:module';
import { ERROR_CODES, formatError, formatFatalError } from './error-codes.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createProviderByName, getProviderNames, DEFAULT_PROVIDER_NAME } from './provider-registry.js';
import { getAvailableFormats } from './formatters/index.js';
import { getAvailableLogTypes, isValidLogLevel, getLogLevel, setLogLevel } from './logging.js';
import { DEFAULT_MODEL } from './types.js';
import type { RuntimeConfig, ProviderModelInfo } from './types.js';
import {
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_TYPE,
  DEFAULT_GENERIC_PROMPT,
  DEFAULT_FAIL_ON_CHECK_FAILURE,
} from './defaults.js';

/** Defaults shown in interactive prompts so users know what they'd get by leaving a field unset.
 *  Sourced from the same constants the scanner uses at runtime — no duplication. */
const SCAN_DEFAULTS = {
  provider: DEFAULT_PROVIDER_NAME,
  model: DEFAULT_MODEL,
  outputFormat: DEFAULT_OUTPUT_FORMAT,
  outputDirectory: '<repo-path>', // No constant — derived at runtime from the scanned repo path
  logLevel: DEFAULT_LOG_LEVEL,
  logType: DEFAULT_LOG_TYPE,
  genericPrompt: DEFAULT_GENERIC_PROMPT,
  failOnCheckFailure: DEFAULT_FAIL_ON_CHECK_FAILURE,
} as const;

const VALID_LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
const VALID_BOOLS = ['true', 'false'] as const;

interface ParsedFlags {
  configDir?: string;
  runtimeConfig?: string;
  provider?: string;
  model?: string;
  outputFormat?: string;
  outputDirectory?: string;
  logLevel?: string;
  logFile?: string;
  logType?: string;
  genericPrompt?: string;
  failOnCheckFailure?: string;
  nonInteractive?: boolean;
  clear?: string[];
}

const FLAG_MAP: Record<string, keyof Omit<ParsedFlags, 'nonInteractive' | 'clear'>> = {
  '--config-dir': 'configDir',
  '--runtime-config': 'runtimeConfig',
  '--provider': 'provider',
  '--model': 'model',
  '--output-format': 'outputFormat',
  '--output-directory': 'outputDirectory',
  '--log-level': 'logLevel',
  '--log-file': 'logFile',
  '--log-type': 'logType',
  '--generic-prompt': 'genericPrompt',
  '--fail-on-check-failure': 'failOnCheckFailure',
};

const KNOWN_FLAGS = new Set<string>([...Object.keys(FLAG_MAP), '--non-interactive', '--clear', '--help', '-h']);

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  const clear: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--non-interactive') {
      flags.nonInteractive = true;
      continue;
    }
    if (arg === '--clear') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(formatError(ERROR_CODES.E1001, '--clear requires a field name'));
        process.exit(1);
      }
      clear.push(value);
      i++;
      continue;
    }
    const key = FLAG_MAP[arg];
    if (key) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(formatError(ERROR_CODES.E1001, `${arg} requires a value`));
        process.exit(1);
      }
      flags[key] = value;
      i++;
      continue;
    }
    if (arg.startsWith('--') || arg.startsWith('-')) {
      // Unknown option — fail fast instead of silently ignoring (catches typos like `--outpt-format`).
      const known = [...KNOWN_FLAGS].sort().join(', ');
      console.error(formatError(ERROR_CODES.E1001, `Unknown option "${arg}". Known: ${known}`));
      process.exit(1);
    }
    // Bare positional args are not used by build-config.
    console.error(formatError(ERROR_CODES.E1001, `Unexpected positional argument "${arg}"`));
    process.exit(1);
  }
  if (clear.length > 0) {
    flags.clear = clear;
  }
  return flags;
}

const HELP = `Usage: aghast build-config [options]

Build or edit a runtime-config.json file. Interactive by default; pass --non-interactive
or any value flags to skip prompts. If the target file already exists, its values are
loaded as defaults — only fields you change are updated.

Target file:
  --config-dir <path>           Write to <path>/runtime-config.json (created if missing)
  --runtime-config <path>       Write to an explicit file path
                                (one of these is required; --runtime-config wins if both
                                are given)

Field flags (any value provided here skips its prompt; closed lists are validated):
  --provider <name>             Agent provider name (e.g. claude-code)
  --model <id>                  Model ID. Must be one returned by the provider's
                                listModels() (skip flag and use interactive mode to
                                browse the live list).
  --output-format <fmt>         Output format: json | sarif | csv | html
  --output-directory <path>     Default output directory for results
  --log-level <level>           Console log level: error | warn | info | debug | trace
  --log-file <path>             Log file path (omit to disable)
  --log-type <type>             Log file handler type (default: file)
  --generic-prompt <file>       Generic prompt template filename
  --fail-on-check-failure <b>   true | false

Mode flags:
  --non-interactive             Don't prompt — use existing values / defaults / flags only
  --clear <field>               Remove a field from the config. May be repeated.
                                Fields: provider, model, outputFormat, outputDirectory,
                                logLevel, logFile, logType, genericPrompt,
                                failOnCheckFailure
  -h, --help                    Show this help message

Examples:
  aghast build-config --config-dir ./my-checks
  aghast build-config --config-dir ./my-checks --provider claude-code --model sonnet --non-interactive
  aghast build-config --runtime-config ./prod.json --output-format sarif --fail-on-check-failure true
  aghast build-config --config-dir ./my-checks --clear logFile --clear genericPrompt`;

const CLEARABLE_FIELDS = new Set([
  'provider',
  'model',
  'outputFormat',
  'outputDirectory',
  'logLevel',
  'logFile',
  'logType',
  'genericPrompt',
  'failOnCheckFailure',
]);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function configToFlatDefaults(config: RuntimeConfig): {
  provider?: string;
  model?: string;
  outputFormat?: string;
  outputDirectory?: string;
  logLevel?: string;
  logFile?: string;
  logType?: string;
  genericPrompt?: string;
  failOnCheckFailure?: boolean;
} {
  return {
    provider: config.agentProvider?.name,
    model: config.agentProvider?.model,
    outputFormat: config.reporting?.outputFormat,
    outputDirectory: config.reporting?.outputDirectory,
    logLevel: config.logging?.level,
    logFile: config.logging?.logFile,
    logType: config.logging?.logType,
    genericPrompt: config.genericPrompt,
    failOnCheckFailure: config.failOnCheckFailure,
  };
}

interface BuiltValues {
  provider?: string;
  model?: string;
  outputFormat?: string;
  outputDirectory?: string;
  logLevel?: string;
  logFile?: string;
  logType?: string;
  genericPrompt?: string;
  failOnCheckFailure?: boolean;
}

function buildConfig(values: BuiltValues): RuntimeConfig {
  const config: RuntimeConfig = {};
  if (values.provider !== undefined || values.model !== undefined) {
    config.agentProvider = {};
    if (values.provider !== undefined) config.agentProvider.name = values.provider;
    if (values.model !== undefined) config.agentProvider.model = values.model;
  }
  if (values.outputFormat !== undefined || values.outputDirectory !== undefined) {
    config.reporting = {};
    if (values.outputFormat !== undefined) config.reporting.outputFormat = values.outputFormat;
    if (values.outputDirectory !== undefined) config.reporting.outputDirectory = values.outputDirectory;
  }
  if (values.logLevel !== undefined || values.logFile !== undefined || values.logType !== undefined) {
    config.logging = {};
    if (values.logLevel !== undefined) config.logging.level = values.logLevel;
    if (values.logFile !== undefined) config.logging.logFile = values.logFile;
    if (values.logType !== undefined) config.logging.logType = values.logType;
  }
  if (values.genericPrompt !== undefined) config.genericPrompt = values.genericPrompt;
  if (values.failOnCheckFailure !== undefined) config.failOnCheckFailure = values.failOnCheckFailure;
  return config;
}

async function getProviderModels(providerName: string): Promise<readonly ProviderModelInfo[]> {
  const provider = createProviderByName(providerName);
  // Silence provider progress logs ("Starting OpenCode server...", etc.) during the
  // throwaway init/teardown used to fetch the model list. The user is in an interactive
  // picker and doesn't need to see transient server lifecycle noise. Errors still surface
  // via thrown exceptions, which the caller catches and reports.
  const savedLevel = getLogLevel();
  setLogLevel('silent');
  try {
    // Honor the AgentProvider contract — initialize() before any other method call.
    // We intentionally pass an empty config so the provider falls back to env vars (e.g.
    // ANTHROPIC_API_KEY). For providers like Claude Code that require either a key or
    // AGHAST_LOCAL_CLAUDE=true, initialization may throw — let it propagate so callers
    // can catch and degrade (e.g. fall back to free-text model entry).
    await provider.initialize({});
    if (!provider.listModels) {
      return [];
    }
    return await provider.listModels();
  } finally {
    // Providers that start subprocesses/servers (e.g. OpenCode) must be cleaned up,
    // or the process leaks resources until Node exits. cleanup() is documented to be
    // safe on partially-initialized providers. No-op for providers without cleanup.
    await provider.cleanup?.();
    setLogLevel(savedLevel);
  }
}

/** Memoising fetcher — call once per (providerName, run) and re-use the result.
 *
 * Note: this caches the Promise itself, including rejections. That's intentional —
 * if the SDK call fails (e.g. no API key, no local Claude session), we want subsequent
 * lookups within the same run to hit the cached failure rather than retrying and
 * spamming the user with the same warning twice (once interactively, once during
 * validation). Both call sites already handle the rejection by warning + degrading. */
function makeModelFetcher(): (name: string) => Promise<readonly ProviderModelInfo[]> {
  const cache = new Map<string, Promise<readonly ProviderModelInfo[]>>();
  return (name: string) => {
    if (!cache.has(name)) {
      cache.set(name, getProviderModels(name));
    }
    return cache.get(name)!;
  };
}

function formatModelChoice(m: ProviderModelInfo): string {
  const parts: string[] = [m.id];
  if (m.label && m.label !== m.id) parts.push(`— ${m.label}`);
  if (m.description) parts.push(`· ${m.description}`);
  return parts.join(' ');
}

interface PromptHelpers {
  ask(label: string, current: string | undefined, builtInDefault?: string): Promise<string | undefined>;
  askChoice(label: string, choices: readonly string[], current: string | undefined, builtInDefault?: string): Promise<string | undefined>;
  askBool(label: string, current: boolean | undefined, builtInDefault?: boolean): Promise<boolean | undefined>;
  close(): void;
}

function createPromptHelpers(): PromptHelpers {
  const rl = createInterface({ input: stdin, output: stdout });

  function emptyHint(builtInDefault?: string): string {
    if (builtInDefault !== undefined && builtInDefault !== '') {
      return ` (Enter to leave unset — default: ${builtInDefault})`;
    }
    return ' (Enter to leave unset)';
  }

  function setHint(): string {
    return ' (Enter to keep, "-" to clear)';
  }

  async function ask(label: string, current: string | undefined, builtInDefault?: string): Promise<string | undefined> {
    if (current === undefined || current === '') {
      const answer = (await rl.question(`${label}${emptyHint(builtInDefault)}: `)).trim();
      if (answer === '' || answer === '-') return undefined;
      return answer;
    }
    const annotations: string[] = [`current: ${current}`];
    if (builtInDefault !== undefined && builtInDefault !== '' && builtInDefault !== current) {
      annotations.push(`default if cleared: ${builtInDefault}`);
    }
    const answer = (await rl.question(`${label} [${annotations.join(', ')}]${setHint()}: `)).trim();
    if (answer === '') return current;
    if (answer === '-') return undefined;
    return answer;
  }

  async function askChoice(
    label: string,
    choices: readonly string[],
    current: string | undefined,
    builtInDefault?: string,
  ): Promise<string | undefined> {
    if (choices.length === 0) {
      return ask(label, current, builtInDefault);
    }
    const hasCurrent = current !== undefined && choices.includes(current);
    const numbered = choices
      .map((c, i) => {
        const annotations: string[] = [];
        if (hasCurrent && c === current) annotations.push('current');
        if (builtInDefault !== undefined && c === builtInDefault) annotations.push('default');
        return `  ${i + 1}) ${c}${annotations.length > 0 ? ` (${annotations.join(', ')})` : ''}`;
      })
      .join('\n');
    // For numbered choices, the "(default)" annotation in the list above is enough —
    // don't duplicate it in the hint (Enter doesn't pick the default anyway).
    const hint = hasCurrent ? setHint() : ' (Enter to leave unset)';
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await rl.question(`${label}:\n${numbered}\nChoice${hint}: `)).trim();
      if (answer === '') return hasCurrent ? current : undefined;
      if (answer === '-') return undefined;
      const byNumber = parseInt(answer, 10);
      if (!isNaN(byNumber) && byNumber >= 1 && byNumber <= choices.length) {
        return choices[byNumber - 1];
      }
      if (choices.includes(answer)) return answer;
      console.error(`Invalid choice "${answer}". Enter a number 1-${choices.length} or the value.`);
    }
    throw new Error(`No valid choice for "${label}" after 3 attempts`);
  }

  async function askBool(label: string, current: boolean | undefined, builtInDefault?: boolean): Promise<boolean | undefined> {
    const choice = await askChoice(
      label,
      VALID_BOOLS,
      current === undefined ? undefined : String(current),
      builtInDefault === undefined ? undefined : String(builtInDefault),
    );
    if (choice === undefined) return undefined;
    return choice === 'true';
  }

  return { ask, askChoice, askBool, close: () => rl.close() };
}

function validateAgainst(label: string, value: string | undefined, allowed: readonly string[]): void {
  if (value === undefined) return;
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${label} "${value}". Must be one of: ${allowed.join(', ')}`);
  }
}

export async function runBuildConfig(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);

  // Validate --clear field names early
  if (flags.clear) {
    for (const field of flags.clear) {
      if (!CLEARABLE_FIELDS.has(field)) {
        console.error(formatError(ERROR_CODES.E1001, `Unknown --clear field "${field}". Valid fields: ${[...CLEARABLE_FIELDS].join(', ')}`));
        process.exit(1);
      }
    }
  }

  // Resolve target file path
  let targetPath: string;
  if (flags.runtimeConfig) {
    targetPath = resolve(flags.runtimeConfig);
  } else if (flags.configDir) {
    targetPath = resolve(flags.configDir, 'runtime-config.json');
  } else if (process.env.AGHAST_CONFIG_DIR) {
    targetPath = resolve(process.env.AGHAST_CONFIG_DIR, 'runtime-config.json');
  } else {
    console.error(formatError(ERROR_CODES.E2001, 'One of --config-dir or --runtime-config is required (or set AGHAST_CONFIG_DIR).'));
    process.exit(1);
  }

  // Load existing config (or empty)
  const exists = await fileExists(targetPath);
  let existing: RuntimeConfig = {};
  if (exists) {
    try {
      existing = await loadRuntimeConfig(undefined, targetPath);
      console.log(`Loaded existing config from ${targetPath}`);
    } catch (err) {
      console.error(formatError(ERROR_CODES.E2005, err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  } else {
    console.log(`No existing config at ${targetPath} — creating new one.`);
  }

  const defaults = configToFlatDefaults(existing);

  // Validate provider flag if given (so we can fetch model list)
  if (flags.provider !== undefined) {
    const known = getProviderNames();
    if (!known.includes(flags.provider)) {
      console.error(formatError(ERROR_CODES.E3002, `Unknown provider "${flags.provider}". Known: ${known.join(', ')}`));
      process.exit(1);
    }
  }

  const interactive = !flags.nonInteractive
    && (process.stdin.isTTY ?? false);

  // Reject conflicting --clear <field> + --<field> <value>: ambiguous intent.
  // `field` here is already validated against CLEARABLE_FIELDS (which never contains
  // 'clear' or 'nonInteractive'), so `flags[field]` only resolves to value-bearing flags.
  if (flags.clear) {
    const conflicts: string[] = [];
    for (const field of flags.clear) {
      if (flags[field as keyof ParsedFlags] !== undefined) {
        conflicts.push(field);
      }
    }
    if (conflicts.length > 0) {
      const list = conflicts.map((f) => `--clear ${f} and --${f.replace(/([A-Z])/g, '-$1').toLowerCase()}`).join(', ');
      console.error(formatError(ERROR_CODES.E1001, `Conflicting flags: ${list}. Use one or the other for each field.`));
      process.exit(1);
    }
  }

  const result: BuiltValues = { ...defaults };

  // Apply --clear first
  if (flags.clear) {
    for (const field of flags.clear) {
      (result as Record<string, unknown>)[field] = undefined;
    }
  }

  // Apply explicit flag values
  if (flags.provider !== undefined) result.provider = flags.provider;
  if (flags.outputFormat !== undefined) result.outputFormat = flags.outputFormat;
  if (flags.outputDirectory !== undefined) result.outputDirectory = flags.outputDirectory;
  if (flags.logLevel !== undefined) result.logLevel = flags.logLevel;
  if (flags.logFile !== undefined) result.logFile = flags.logFile;
  if (flags.logType !== undefined) result.logType = flags.logType;
  if (flags.genericPrompt !== undefined) result.genericPrompt = flags.genericPrompt;
  if (flags.failOnCheckFailure !== undefined) {
    if (!VALID_BOOLS.includes(flags.failOnCheckFailure as 'true' | 'false')) {
      console.error(formatError(ERROR_CODES.E1001, `Invalid --fail-on-check-failure "${flags.failOnCheckFailure}". Must be true or false.`));
      process.exit(1);
    }
    result.failOnCheckFailure = flags.failOnCheckFailure === 'true';
  }
  // Model is applied last, after we have a resolved provider, so we can validate against listModels
  const pendingModelFlag = flags.model;

  // Cache provider→models lookups so we never call the SDK twice in one run.
  const fetchModels = makeModelFetcher();

  // Interactive prompts (only for fields not set by flags)
  if (interactive) {
    const helpers = createPromptHelpers();
    try {
      const providers = getProviderNames();
      if (flags.provider === undefined) {
        result.provider = await helpers.askChoice('Agent provider', providers, result.provider, SCAN_DEFAULTS.provider);
      }

      // Resolve provider for model listing — fall back to default only for the SDK call,
      // not as a faked "current" value in the prompt above.
      const providerForModels = result.provider ?? DEFAULT_PROVIDER_NAME;
      let availableModels: readonly ProviderModelInfo[] = [];
      if (providers.includes(providerForModels)) {
        try {
          availableModels = await fetchModels(providerForModels);
        } catch (err) {
          console.error(`Warning: could not fetch model list from "${providerForModels}": ${err instanceof Error ? err.message : String(err)}`);
          console.error('Falling back to free-text model entry.');
        }
      }

      if (pendingModelFlag === undefined) {
        if (availableModels.length === 0) {
          result.model = await helpers.ask('AI model', result.model, SCAN_DEFAULTS.model);
        } else {
          const labels = availableModels.map(formatModelChoice);
          // Match by id (not string-prefix on labels) — labels may include description text
          // that could collide with another model's id.
          const currentIdx = result.model
            ? availableModels.findIndex((m) => m.id === result.model)
            : -1;
          const defaultIdx = availableModels.findIndex((m) => m.id === SCAN_DEFAULTS.model);
          const currentLabel = currentIdx >= 0 ? labels[currentIdx] : undefined;
          const defaultLabel = defaultIdx >= 0 ? labels[defaultIdx] : undefined;
          const chosen = await helpers.askChoice('AI model (from provider SDK)', labels, currentLabel, defaultLabel);
          if (chosen === undefined) {
            result.model = undefined;
          } else {
            const idx = labels.indexOf(chosen);
            result.model = idx >= 0 ? availableModels[idx].id : chosen;
          }
        }
      }

      if (flags.outputFormat === undefined) {
        result.outputFormat = await helpers.askChoice('Output format', getAvailableFormats(), result.outputFormat, SCAN_DEFAULTS.outputFormat);
      }
      if (flags.outputDirectory === undefined) {
        result.outputDirectory = await helpers.ask('Output directory', result.outputDirectory, SCAN_DEFAULTS.outputDirectory);
      }
      if (flags.logLevel === undefined) {
        result.logLevel = await helpers.askChoice('Log level', VALID_LOG_LEVELS, result.logLevel, SCAN_DEFAULTS.logLevel);
      }
      if (flags.logFile === undefined) {
        result.logFile = await helpers.ask('Log file path', result.logFile);
      }
      if (flags.logType === undefined) {
        const logTypes = getAvailableLogTypes();
        result.logType = await helpers.askChoice('Log type', logTypes, result.logType, SCAN_DEFAULTS.logType);
      }
      if (flags.genericPrompt === undefined) {
        result.genericPrompt = await helpers.ask('Generic prompt template filename', result.genericPrompt, SCAN_DEFAULTS.genericPrompt);
      }
      if (flags.failOnCheckFailure === undefined) {
        result.failOnCheckFailure = await helpers.askBool('Fail on check failure', result.failOnCheckFailure, SCAN_DEFAULTS.failOnCheckFailure);
      }
    } catch (err) {
      // Includes "No valid choice for X after N attempts" — surface as a usage error.
      // process.exit terminates synchronously without running pending finally blocks,
      // so the readline handle is left for the OS to reclaim on this path. That's fine —
      // the process is dying anyway. The finally below only runs on the happy path.
      console.error(formatError(ERROR_CODES.E1003, err instanceof Error ? err.message : String(err)));
      process.exit(1);
    } finally {
      helpers.close();
    }
  }

  // Apply pending model flag now (after interactive may have changed provider)
  if (pendingModelFlag !== undefined) {
    result.model = pendingModelFlag;
  }

  // Validate selections against closed lists
  try {
    if (result.provider !== undefined) {
      validateAgainst('provider', result.provider, getProviderNames());
    }
    if (result.model !== undefined) {
      const providerForValidation = result.provider ?? DEFAULT_PROVIDER_NAME;
      if (getProviderNames().includes(providerForValidation)) {
        try {
          const allowed = await fetchModels(providerForValidation);
          if (allowed.length > 0) {
            const allowedIds = allowed.map((m) => m.id);
            validateAgainst(`model for provider "${providerForValidation}"`, result.model, allowedIds);
          }
        } catch (err) {
          console.error(`Warning: skipped model validation — could not fetch model list: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    validateAgainst('output format', result.outputFormat, getAvailableFormats());
    if (result.logLevel !== undefined && !isValidLogLevel(result.logLevel)) {
      throw new Error(`Invalid log level "${result.logLevel}". Must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
    }
    validateAgainst('log type', result.logType, getAvailableLogTypes());
  } catch (err) {
    console.error(formatError(ERROR_CODES.E2005, err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const finalConfig = buildConfig(result);

  // Bootstrap parent directory if needed
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(finalConfig, null, 2) + '\n', 'utf-8');
  console.log(`\nWrote runtime config to ${targetPath}`);
}

// Auto-run when executed directly, but not when imported by cli.ts.
if (!process.env._AGHAST_CLI) {
  await import('dotenv/config');
  runBuildConfig(process.argv.slice(2)).catch((err) => {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    console.error('');
    console.error(formatFatalError(err instanceof Error ? err.message : String(err), pkg.version));
    process.exit(1);
  });
}
