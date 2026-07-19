/**
 * Script-based target discovery.
 *
 * Runs a user-provided script (`node` or `bash`) in the target repository
 * and parses its stdout to produce discovery targets. Useful when target
 * discovery is too custom for Semgrep / SARIF / OpenAnt — e.g. parsing an
 * OpenAPI spec, querying a build manifest, walking a database schema, etc.
 *
 * ─── Trust model ─────────────────────────────────────────────────────────────
 *
 * Scripts run with the full privileges of the aghast process. They are not
 * sandboxed. Treat any script referenced by a check definition as trusted
 * code — only enable script-discovery checks whose script you (or your team)
 * have read and audited.
 *
 * Defensive measures applied here:
 * - Script path must resolve INSIDE the configured check folder or repo
 *   (no `..` escape, no absolute paths to /etc/shadow, etc.).
 * - Symlink-aware: both the script path and `cwd` are realpath'd and
 *   re-checked against the repo root, so a symlink inside the check folder
 *   pointing outside the repo cannot be used to execute external code.
 * - Spawned with `shell: false` and array args — no shell interpolation, no
 *   command injection from check-definition fields.
 * - Spawned with a curated environment: only a small allow-list of neutral
 *   env vars (PATH, HOME, locale, temp dirs, Windows essentials) is forwarded.
 *   As defence-in-depth, any var matching a known-secret pattern (`*_KEY`,
 *   `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, or `ANTHROPIC_*` / `OPENAI_*` /
 *   `GITHUB_*` / `AGHAST_*` / `AWS_*` / `GCP_*` / `AZURE_*` prefixes) is
 *   also explicitly dropped. Allow-list matching is case-insensitive so
 *   the Windows-style `Path` / `SystemRoot` casing works the same as POSIX
 *   `PATH`.
 * - cwd, when supplied, must resolve (and realpath) inside the repo root.
 * - Hard timeout (default 30s, configurable per check).
 * - Stdout is bounded (8 MiB) to prevent memory exhaustion from runaway scripts.
 * - Both the line-format and JSON-format output paths cap the number of
 *   parsed targets (MAX_LINE_TARGETS / MAX_JSON_TARGETS) to bound memory
 *   even if a script floods within the stdout cap.
 * - Output is parsed as data (lines / JSON) — never `eval`-ed.
 * - File paths returned by the script are validated to be relative & inside
 *   the repo (no `..` escape, no absolute paths) before they are forwarded
 *   to the AI prompt or snippet extractor.
 * - On `bash` scripts, Windows is unsupported (no system bash) and a clear
 *   error is raised rather than silently falling back.
 */

import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, normalize } from 'node:path';
import { logDebug, logProgress, logWarn } from '../logging.js';
import { ERROR_CODES, formatError } from '../error-codes.js';
import { DEFAULT_GENERIC_PROMPT } from '../defaults.js';
import type { TargetDiscovery, DiscoveredTarget, DiscoveryOptions } from '../discovery.js';
import type { SecurityCheck } from '../types.js';

const TAG = 'script-discovery';

/** Default timeout: 30s. Overridable per check via `checkTarget.timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Cap on total stdout we will buffer (8 MiB). */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** Cap on total stderr we will buffer (1 MiB) — only used for diagnostics. */
const MAX_STDERR_BYTES = 1 * 1024 * 1024;

/** Maximum number of lines we will keep when parsing `lines` format. */
const MAX_LINE_TARGETS = 100_000;

/** Maximum number of items we will keep when parsing `json-array` / `json-object` format. */
const MAX_JSON_TARGETS = 100_000;

/**
 * Build a curated environment for the spawned discovery script.
 *
 * Discovery scripts need to walk the repo, possibly run small helper tools,
 * but they never need API credentials. We start from a minimal allow-list of
 * "neutral" env vars (PATH/locale/temp dirs) and then ALSO drop any var whose
 * name matches a known-secret pattern even if it slipped through. Both layers
 * are defence-in-depth.
 *
 * Exported for testing.
 */
export function buildScriptEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Allow-list: variables a normal CLI tool needs to function.
  // Case-insensitive: on Windows `process.env` enumerates keys with their
  // original casing (e.g. `Path`, `SystemRoot`, `ProgramFiles`), so a strict
  // case-sensitive `Set.has` would drop those vars and break script
  // discovery on Windows. We normalize to upper-case for membership checks.
  const ALLOW_LIST_UPPER: ReadonlySet<string> = new Set(
    [
      'PATH',
      'HOME',
      'USER',
      'USERNAME',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'LC_MESSAGES',
      'LC_NUMERIC',
      'LC_TIME',
      'TZ',
      'TMPDIR',
      'TMP',
      'TEMP',
      // Windows essentials (uppercased — case-insensitive match below)
      'SYSTEMROOT',
      'SYSTEMDRIVE',
      'COMSPEC',
      'PATHEXT',
      'WINDIR',
      'APPDATA',
      'LOCALAPPDATA',
      'PROGRAMDATA',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'PUBLIC',
      'USERPROFILE',
    ].map((s) => s.toUpperCase()),
  );
  // Block-list patterns: never forward, even if they accidentally appear in
  // the allow-list. The `i` flag makes them case-insensitive too.
  const BLOCK_PATTERNS: ReadonlyArray<RegExp> = [
    /(?:^|_)KEY$/i,
    /(?:^|_)TOKEN$/i,
    /(?:^|_)SECRET$/i,
    /(?:^|_)PASSWORD$/i,
    /(?:^|_)PASSWD$/i,
    /^ANTHROPIC_/i,
    /^OPENAI_/i,
    /^GITHUB_/i,
    /^AGHAST_/i, // aghast-internal config should not leak to discovery scripts
    /^AWS_/i,
    /^GCP_/i,
    /^AZURE_/i,
    /^NPM_TOKEN/i,
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (!ALLOW_LIST_UPPER.has(k.toUpperCase())) continue;
    if (BLOCK_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

interface ScriptTargetInput {
  file: string;
  startLine?: number;
  endLine?: number;
  message?: string;
  snippet?: string;
}

/**
 * Verify that `candidateAbs` (an already-resolved absolute path) lives inside
 * `rootAbs` (also absolute). Throws via `formatError(E2004, ...)` if the
 * candidate escapes the root. Returns void.
 *
 * Used both for the textual `resolve` check and for the post-`realpath`
 * symlink-aware re-check.
 */
function assertInsideRoot(rootAbs: string, candidateAbs: string, label: string): void {
  const rel = relative(rootAbs, candidateAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      formatError(
        ERROR_CODES.E2004,
        `${label} "${candidateAbs}" resolves outside of "${rootAbs}" — refusing to run`,
      ),
    );
  }
}

/**
 * Symlink-aware path validation. Resolves the realpath of `target` and verifies
 * the realpath is still inside `rootAbs`. If the target does not yet exist
 * (e.g. cwd that the script will create), falls back to the textual path.
 */
async function assertRealpathInsideRoot(
  rootAbs: string,
  target: string,
  label: string,
): Promise<void> {
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    // Path may not exist yet — textual check (already performed elsewhere) suffices.
    return;
  }
  // realpath of root may itself differ if the repo is reached via a symlink;
  // resolve both ends to be consistent.
  let realRoot: string;
  try {
    realRoot = await realpath(rootAbs);
  } catch {
    realRoot = rootAbs;
  }
  assertInsideRoot(realRoot, realTarget, `${label} (after symlink resolution)`);
}

/**
 * Resolve a path that should live inside `root`. Throws if the resolved
 * absolute path escapes the root directory (path traversal protection).
 *
 * Both `..` segments and absolute-path inputs are handled by re-resolving
 * against `root` and then verifying that `relative(root, resolved)` does
 * not start with `..`.
 *
 * NOTE: This is a textual check only — it does NOT follow symlinks. Callers
 * that care about symlink escape (e.g. when about to spawn the file as code)
 * should additionally call `assertRealpathInsideRoot`.
 */
function resolveInside(root: string, candidate: string, label: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(formatError(ERROR_CODES.E2004, `${label} must be a non-empty string`));
  }
  // Reject absolute paths up-front: scripts in check definitions should be
  // expressed relative to the check folder / repo, never absolute.
  if (isAbsolute(candidate)) {
    throw new Error(
      formatError(ERROR_CODES.E2004, `${label} must be a relative path, got absolute: "${candidate}"`),
    );
  }
  const rootAbs = resolve(root);
  const resolved = resolve(rootAbs, candidate);
  assertInsideRoot(rootAbs, resolved, label);
  return resolved;
}

/**
 * Validate a file path emitted by a script: must be relative, must not
 * traverse outside the repo via `..`. Returns the normalized path.
 */
function validateScriptFilePath(file: string, idx: number): string {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(formatError(ERROR_CODES.E7105, `Script target[${idx}].file must be a non-empty string`));
  }
  if (isAbsolute(file)) {
    throw new Error(
      formatError(
        ERROR_CODES.E7105,
        `Script target[${idx}].file must be relative (got absolute: "${file}")`,
      ),
    );
  }
  // normalize collapses redundant segments; if the result starts with `..`
  // the path escapes the repo root.
  const norm = normalize(file).replace(/\\/g, '/');
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('..\\')) {
    throw new Error(
      formatError(
        ERROR_CODES.E7105,
        `Script target[${idx}].file "${file}" escapes the repository root via ".."`,
      ),
    );
  }
  return norm;
}

/**
 * Parse stdout into a list of discovery target inputs.
 * - `lines`: one file path per non-empty, non-comment line.
 * - `json-array`: a JSON array of strings (file paths) or objects.
 * - `json-object`: an object with a `targets` array of strings or objects.
 *
 * Both `lines` and JSON formats cap parsed targets at MAX_LINE_TARGETS /
 * MAX_JSON_TARGETS (100k each); the rest are dropped with a warning log.
 *
 * Output is treated as DATA: never eval'd, never interpolated into commands.
 */
export function parseScriptOutput(
  raw: string,
  format: 'lines' | 'json-array' | 'json-object',
): ScriptTargetInput[] {
  if (format === 'lines') {
    // NOTE: the `lines` format treats blank lines and lines starting with `#`
    // as comments and skips them. Documented intentionally — file paths
    // beginning with `#` are unusual and unsupported.
    const out: ScriptTargetInput[] = [];
    let truncated = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('#')) continue;
      out.push({ file: trimmed });
      if (out.length >= MAX_LINE_TARGETS) {
        truncated = true;
        break;
      }
    }
    if (truncated) {
      logWarn(
        TAG,
        `Script output truncated at MAX_LINE_TARGETS=${MAX_LINE_TARGETS}; remaining lines ignored`,
      );
    }
    return out;
  }

  // JSON formats
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      formatError(
        ERROR_CODES.E7105,
        `Script output is not valid JSON for outputFormat=${format}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      { cause: err },
    );
  }

  let arr: unknown;
  if (format === 'json-array') {
    if (!Array.isArray(parsed)) {
      throw new Error(
        formatError(ERROR_CODES.E7105, `Script outputFormat=json-array expects a JSON array at the root`),
      );
    }
    arr = parsed;
  } else {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        formatError(
          ERROR_CODES.E7105,
          `Script outputFormat=json-object expects a JSON object with a "targets" array`,
        ),
      );
    }
    const targets = (parsed as Record<string, unknown>).targets;
    if (!Array.isArray(targets)) {
      throw new Error(
        formatError(
          ERROR_CODES.E7105,
          `Script outputFormat=json-object expects a "targets" array; got ${typeof targets}`,
        ),
      );
    }
    arr = targets;
  }

  const out: ScriptTargetInput[] = [];
  const items = arr as unknown[];
  // Cap JSON-parsed item count to bound memory even if the script flooded
  // structured output within the stdout cap.
  const limit = Math.min(items.length, MAX_JSON_TARGETS);
  if (items.length > MAX_JSON_TARGETS) {
    logWarn(
      TAG,
      `Script JSON output truncated at MAX_JSON_TARGETS=${MAX_JSON_TARGETS} (script returned ${items.length} items)`,
    );
  }
  for (let i = 0; i < limit; i++) {
    const item = items[i];
    if (typeof item === 'string') {
      out.push({ file: item });
      continue;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(
        formatError(
          ERROR_CODES.E7105,
          `Script target[${i}] must be a string or object, got ${Array.isArray(item) ? 'array' : typeof item}`,
        ),
      );
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.file !== 'string' || obj.file.length === 0) {
      throw new Error(
        formatError(ERROR_CODES.E7105, `Script target[${i}].file must be a non-empty string`),
      );
    }
    const t: ScriptTargetInput = { file: obj.file };
    if (obj.startLine !== undefined) {
      if (typeof obj.startLine !== 'number' || !Number.isFinite(obj.startLine) || obj.startLine < 0) {
        throw new Error(
          formatError(ERROR_CODES.E7105, `Script target[${i}].startLine must be a non-negative number`),
        );
      }
      t.startLine = Math.floor(obj.startLine);
    }
    if (obj.endLine !== undefined) {
      if (typeof obj.endLine !== 'number' || !Number.isFinite(obj.endLine) || obj.endLine < 0) {
        throw new Error(
          formatError(ERROR_CODES.E7105, `Script target[${i}].endLine must be a non-negative number`),
        );
      }
      t.endLine = Math.floor(obj.endLine);
    }
    if (obj.message !== undefined) {
      if (typeof obj.message !== 'string') {
        throw new Error(formatError(ERROR_CODES.E7105, `Script target[${i}].message must be a string`));
      }
      t.message = obj.message;
    }
    if (obj.snippet !== undefined) {
      if (typeof obj.snippet !== 'string') {
        throw new Error(formatError(ERROR_CODES.E7105, `Script target[${i}].snippet must be a string`));
      }
      t.snippet = obj.snippet;
    }
    out.push(t);
  }
  return out;
}

interface RunScriptResult {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * Execute the script as a child process and capture stdout.
 * - Uses `spawn` with `shell: false`: never invoke a shell, never interpolate.
 * - Passes a curated env (no API keys / tokens) — see `buildScriptEnv`.
 * - Bounds stdout/stderr buffers and kills the process on timeout.
 */
export function runScript(opts: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RunScriptResult> {
  return new Promise((resolvePromise, reject) => {
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let stdoutTruncated = false;

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: opts.env ?? buildScriptEnv(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process; on POSIX SIGKILL is unmaskable. On Windows
      // Node's kill() invokes TerminateProcess regardless of the signal.
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      if (stdoutLen + chunk.length > MAX_STDOUT_BYTES) {
        stdoutTruncated = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrLen + chunk.length > MAX_STDERR_BYTES) return;
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            formatError(
              ERROR_CODES.E7101,
              `Script discovery timed out after ${opts.timeoutMs}ms`,
            ),
          ),
        );
        return;
      }
      if (stdoutTruncated) {
        reject(
          new Error(
            formatError(
              ERROR_CODES.E7103,
              `Script discovery stdout exceeded ${MAX_STDOUT_BYTES} bytes — aborted`,
            ),
          ),
        );
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
        signal,
      });
    });
  });
}

/**
 * Resolve the runtime command + leading args for a given scriptType.
 * Returns `[command, ...leadingArgs]`. The script path is appended later.
 */
function commandForScriptType(scriptType: 'node' | 'bash'): [string, string[]] {
  if (scriptType === 'node') {
    // Use the same Node binary that's running aghast — avoids surprises from
    // PATH lookups picking up an unexpected node.
    return [process.execPath, []];
  }
  if (scriptType === 'bash') {
    if (process.platform === 'win32') {
      throw new Error(
        formatError(
          ERROR_CODES.E7106,
          `scriptType="bash" is not supported on Windows; use scriptType="node" instead`,
        ),
      );
    }
    // Use bare `bash` so PATH lookup works on systems where bash lives at
    // /usr/bin/bash, /usr/local/bin/bash, NixOS store paths, etc. spawn() with
    // shell:false still resolves bare command names through PATH.
    return ['bash', []];
  }
  // Should be unreachable due to upstream validation.
  throw new Error(
    formatError(ERROR_CODES.E7106, `Unknown scriptType: "${scriptType as string}"`),
  );
}

export const scriptDiscovery: TargetDiscovery = {
  name: 'script',
  defaultGenericPrompt: DEFAULT_GENERIC_PROMPT,
  needsInstructions: true,
  // Opted out deliberately, same reasoning as the glob discovery.
  // `supportsDiffFilter` became a required field on TargetDiscovery after this
  // discovery was written (#227). A discovery script can emit either whole-file
  // targets or explicit line ranges, so filter behaviour would vary per script
  // with nothing to validate it against. Opting out preserves the behaviour
  // this discovery was built and tested with: the script decides the target
  // set, and aghast analyses all of it.
  supportsDiffFilter: false,

  async discover(
    check: SecurityCheck,
    repoPath: string,
    _options?: DiscoveryOptions,
  ): Promise<DiscoveredTarget[]> {
    const checkTarget = check.checkTarget!;

    if (!checkTarget.script) {
      throw new Error(
        formatError(
          ERROR_CODES.E2004,
          `Check "${check.id}" uses script discovery but has no "script" in its check definition`,
        ),
      );
    }
    if (!checkTarget.scriptType) {
      throw new Error(
        formatError(
          ERROR_CODES.E2004,
          `Check "${check.id}" uses script discovery but has no "scriptType" in its check definition`,
        ),
      );
    }
    if (!checkTarget.outputFormat) {
      throw new Error(
        formatError(
          ERROR_CODES.E2004,
          `Check "${check.id}" uses script discovery but has no "outputFormat" in its check definition`,
        ),
      );
    }

    // Script path: resolve relative to check folder if available, else repo root.
    // Then re-validate that the absolute resolution is inside the repo (so
    // a check folder symlinked outside the repo can't be used to escape).
    const checkBase = check.checkDir ?? repoPath;
    const repoRoot = resolve(repoPath);
    let scriptAbs: string;
    try {
      scriptAbs = resolveInside(checkBase, checkTarget.script, 'checkTarget.script');
    } catch (err) {
      // Re-throw with check id for context
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${check.id}] ${msg}`, { cause: err });
    }

    // Defence-in-depth: also enforce script lives inside the repo root, so that
    // even if checkDir points outside the repo we don't run arbitrary scripts.
    // Skip this check when the check folder itself lives outside the repo
    // (the common case during local dev where checks-config/ is a sibling of
    // the target repo) — in that case resolveInside(checkBase, ...) above
    // already constrained the script to the check folder.
    const checkBaseAbs = resolve(checkBase);
    const checkBaseInsideRepo = !relative(repoRoot, checkBaseAbs).startsWith('..');
    if (checkBaseInsideRepo) {
      // re-raise propagates the original E2004-formatted message
      assertInsideRoot(repoRoot, scriptAbs, `[${check.id}] checkTarget.script`);
    }

    // Validate script file exists & is readable.
    try {
      await readFile(scriptAbs, { flag: 'r' });
    } catch (err) {
      throw new Error(
        formatError(
          ERROR_CODES.E7104,
          `[${check.id}] script "${checkTarget.script}" not found or unreadable at "${scriptAbs}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
        { cause: err },
      );
    }

    // Symlink-aware re-check: if the script (or any parent component) is a
    // symlink whose realpath escapes the constraining root, refuse to run.
    // We use the check folder as the constraining root when checkBase is
    // outside the repo (local-dev case); otherwise we use the repo root.
    const symlinkConstrainingRoot = checkBaseInsideRepo ? repoRoot : checkBaseAbs;
    await assertRealpathInsideRoot(
      symlinkConstrainingRoot,
      scriptAbs,
      `[${check.id}] checkTarget.script`,
    );

    // Resolve cwd: must be inside repo. Defaults to repo root.
    let scriptCwd = repoRoot;
    if (checkTarget.cwd !== undefined) {
      try {
        scriptCwd = resolveInside(repoRoot, checkTarget.cwd, 'checkTarget.cwd');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[${check.id}] ${msg}`, { cause: err });
      }
      // Symlink-aware cwd check.
      await assertRealpathInsideRoot(repoRoot, scriptCwd, `[${check.id}] checkTarget.cwd`);
    }

    const timeoutMs =
      typeof checkTarget.timeoutMs === 'number' && checkTarget.timeoutMs > 0
        ? Math.floor(checkTarget.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    const [command, leadingArgs] = commandForScriptType(checkTarget.scriptType);
    // No shell interpolation: array args, shell:false in spawn.
    const args = [...leadingArgs, scriptAbs];

    logProgress(TAG, `Running script discovery for check ${check.id}: ${checkTarget.scriptType} ${checkTarget.script}`);
    logDebug(TAG, `cmd=${command} args=${JSON.stringify(args)} cwd=${scriptCwd} timeout=${timeoutMs}ms`);

    let result: RunScriptResult;
    try {
      result = await runScript({ command, args, cwd: scriptCwd, timeoutMs });
    } catch (err) {
      // Already-formatted E7xxx errors from runScript pass through cause.
      throw new Error(
        formatError(
          ERROR_CODES.E7104,
          `[${check.id}] script discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { cause: err },
      );
    }

    if (result.exitCode !== 0) {
      const stderrPreview = result.stderr.length > 500 ? result.stderr.slice(0, 500) + '…' : result.stderr;
      throw new Error(
        formatError(
          ERROR_CODES.E7102,
          `[${check.id}] script exited with code=${result.exitCode} signal=${result.signal ?? 'none'}; stderr: ${stderrPreview}`,
        ),
      );
    }

    // Surface non-empty stderr even on success (warnings, deprecations).
    if (result.stderr.trim().length > 0) {
      const preview = result.stderr.length > 500 ? result.stderr.slice(0, 500) + '…' : result.stderr;
      logDebug(TAG, `[${check.id}] script stderr (exit 0): ${preview}`);
    }

    if (result.stdout.trim().length === 0) {
      logDebug(TAG, `[${check.id}] script produced empty output — 0 targets`);
      return [];
    }

    const parsedTargets = parseScriptOutput(result.stdout, checkTarget.outputFormat);

    // Apply maxTargets in two places: here (early — bounds memory) and again in
    // scan-runner (canonical limit applied uniformly across discoveries).
    let limited = parsedTargets;
    if (
      typeof checkTarget.maxTargets === 'number' &&
      checkTarget.maxTargets > 0 &&
      limited.length > checkTarget.maxTargets
    ) {
      limited = limited.slice(0, checkTarget.maxTargets);
    }

    logDebug(TAG, `[${check.id}] script produced ${parsedTargets.length} targets (using ${limited.length})`);

    // Convert parsed inputs to DiscoveredTarget objects.
    return limited.map((t, idx) => {
      // Reject absolute / `..`-traversing file paths before they reach the
      // AI prompt or the snippet extractor.
      const safeFile = validateScriptFilePath(t.file, idx);
      // Normalize line numbers: DiscoveredTarget is documented as 1-based,
      // so coerce undefined or 0 → 1.
      const rawStart = typeof t.startLine === 'number' ? t.startLine : 1;
      const startLine = rawStart < 1 ? 1 : rawStart;
      const rawEnd = typeof t.endLine === 'number' ? t.endLine : startLine;
      const endLine = rawEnd < 1 ? startLine : rawEnd;
      const enrichment = `\n\nTARGET LOCATION (from script discovery):

- File: ${safeFile}
- Lines: ${startLine}-${endLine}${t.message ? `\n- Message: ${t.message}` : ''}
`;
      const out: DiscoveredTarget = {
        file: safeFile,
        startLine,
        endLine,
        label: `[script-target ${idx + 1}/${limited.length}]`,
        promptEnrichment: enrichment,
      };
      if (t.message !== undefined) out.message = t.message;
      if (t.snippet !== undefined) out.snippet = t.snippet;
      return out;
    });
  },
};

