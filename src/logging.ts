/**
 * Pluggable logging system with standard log levels and handler-based architecture.
 *
 * Log levels (standard, syslog-inspired):
 *   error (0) > warn (1) > info (2) > debug (3) > trace (4)
 *
 * Handlers receive structured LogEntry objects and decide how to output them.
 * A ConsoleHandler is registered by default. Additional handlers (e.g. FileHandler)
 * can be added at runtime via addHandler().
 */

import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// --- Log Levels ---

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Legacy log level names accepted by setLogLevel for backward compatibility. */
type LegacyLogLevel = 'silent' | 'info' | 'debug';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const VALID_LOG_LEVELS = new Set<string>(Object.keys(LOG_LEVEL_PRIORITY));

/**
 * Check whether a string is a valid LogLevel.
 */
export function isValidLogLevel(s: string): s is LogLevel {
  return VALID_LOG_LEVELS.has(s);
}

/**
 * A "silent" sentinel: priority -1 means no messages pass the threshold check.
 * Used internally when setLogLevel('silent') is called.
 */
const SILENT_PRIORITY = -1;

// --- Log Entry ---

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
  /**
   * Optional structured data attached to the log entry. Serialized via JSON.stringify()
   * by handlers. Callers should avoid passing untrusted user input directly — log data
   * may contain code snippets or AI responses that are written to log files.
   */
  data?: unknown;
}

// --- Log Handler Interface ---

export interface LogHandler {
  readonly name: string;
  level: LogLevel | 'silent';
  handle(entry: LogEntry): void;
  close?(): Promise<void>;
}

// --- Console Handler ---

export class ConsoleHandler implements LogHandler {
  readonly name = 'console';
  level: LogLevel | 'silent';
  private priority: number;

  constructor(level: LogLevel | 'silent' = 'info') {
    this.level = level;
    this.priority = level === 'silent' ? SILENT_PRIORITY : LOG_LEVEL_PRIORITY[level];
  }

  setLevel(level: LogLevel | 'silent'): void {
    this.level = level;
    this.priority = level === 'silent' ? SILENT_PRIORITY : LOG_LEVEL_PRIORITY[level];
  }

  handle(entry: LogEntry): void {
    const entryPriority = LOG_LEVEL_PRIORITY[entry.level];
    if (entryPriority > this.priority) return;

    const levelTag = entry.level === 'info' ? '' : `[${entry.level}]`;
    // Ensure message is always single-line
    const message = entry.message.includes('\n')
      ? `[base64] ${Buffer.from(entry.message, 'utf-8').toString('base64')}`
      : entry.message;

    if (entry.data === undefined) {
      console.log(`${entry.timestamp} [${entry.tag}]${levelTag} ${message}`);
    } else {
      const formatted = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
      const isMultiline = formatted.includes('\n');
      if (entry.level === 'debug') {
        // Truncate at debug level for console readability
        if (isMultiline) {
          const b64 = Buffer.from(formatted, 'utf-8').toString('base64');
          console.log(`${entry.timestamp} [${entry.tag}]${levelTag} ${message}: [base64] ${b64}`);
        } else {
          const truncated = formatted.length > 200 ? formatted.slice(0, 200) + '...' : formatted;
          console.log(`${entry.timestamp} [${entry.tag}]${levelTag} ${message}: ${truncated}`);
        }
      } else if (entry.level === 'trace') {
        // Trace: always base64-encode data
        const b64 = Buffer.from(formatted, 'utf-8').toString('base64');
        console.log(`${entry.timestamp} [${entry.tag}]${levelTag} ${message}: [base64] ${b64}`);
      } else {
        if (isMultiline) {
          const b64 = Buffer.from(formatted, 'utf-8').toString('base64');
          console.log(`${entry.timestamp} [${entry.tag}]${levelTag} ${message}: [base64] ${b64}`);
        } else {
          console.log(`${entry.timestamp} [${entry.tag}]${levelTag} ${message}: ${formatted}`);
        }
      }
    }
  }
}

// --- File Handler ---

export class FileHandler implements LogHandler {
  readonly name: string;
  level: LogLevel | 'silent';
  private priority: number;
  private fd: number | null = null;

  constructor(filePath: string, level: LogLevel | 'silent' = 'trace', name = 'file') {
    this.name = name;
    this.level = level;
    this.priority = level === 'silent' ? SILENT_PRIORITY : LOG_LEVEL_PRIORITY[level];

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      this.fd = openSync(filePath, 'w', 0o600);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[logging] Failed to open log file "${filePath}": ${msg}`);
      this.fd = null;
    }
  }

  handle(entry: LogEntry): void {
    if (this.fd === null) return;
    const entryPriority = LOG_LEVEL_PRIORITY[entry.level];
    if (entryPriority > this.priority) return;

    const levelTag = `[${entry.level}]`;
    const header = `${entry.timestamp} [${entry.tag}]${levelTag} ${entry.message}`;

    let line: string;
    if (entry.data === undefined) {
      line = header;
    } else {
      const formatted = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
      line = `${header}\n${formatted}\n--- end ---`;
    }
    try {
      writeSync(this.fd, line + '\n');
    } catch (err: unknown) {
      console.warn(`[logging] File handler write error: ${err instanceof Error ? err.message : String(err)}`);
      this.fd = null;
    }
  }

  close(): Promise<void> {
    if (this.fd === null) return Promise.resolve();
    try {
      closeSync(this.fd);
    } catch {
      // best-effort
    }
    this.fd = null;
    return Promise.resolve();
  }
}

// --- Log Type Registry ---

const LOG_TYPE_REGISTRY: Record<string, (path: string, level: LogLevel) => LogHandler> = {
  file: (path, level) => new FileHandler(path, level),
};

/**
 * Create a log handler by type name.
 * @throws Error if the type is not registered
 */
export function createHandlerByType(type: string, path: string, level: LogLevel = 'trace'): LogHandler {
  const factory = LOG_TYPE_REGISTRY[type];
  if (!factory) {
    const available = Object.keys(LOG_TYPE_REGISTRY).join(', ');
    throw new Error(`Unknown log type "${type}". Available types: ${available}`);
  }
  return factory(path, level);
}

/**
 * Get the list of available log type names.
 */
export function getAvailableLogTypes(): string[] {
  return Object.keys(LOG_TYPE_REGISTRY);
}

// --- Handler Registry ---

const handlers: LogHandler[] = [];
let consoleHandler: ConsoleHandler;

function ensureConsoleHandler(): ConsoleHandler {
  if (!consoleHandler) {
    consoleHandler = new ConsoleHandler('info');
    handlers.push(consoleHandler);
  }
  return consoleHandler;
}

// Initialize the default console handler
ensureConsoleHandler();

/**
 * Add a log handler to the registry.
 */
export function addHandler(handler: LogHandler): void {
  handlers.push(handler);
}

/**
 * Remove a log handler by name.
 */
export function removeHandler(name: string): void {
  const idx = handlers.findIndex((h) => h.name === name);
  if (idx !== -1) handlers.splice(idx, 1);
}

/**
 * Close all handlers (flush file streams, etc.) and clear the registry.
 * Re-initializes the console handler afterward.
 */
export async function closeAllHandlers(): Promise<void> {
  const closePromises = handlers
    .map((h) => h.close?.())
    .filter(Boolean)
    .map((p) => (p as Promise<void>).catch((err: Error) => console.warn(`[logging] Handler close failed: ${err.message}`)));
  await Promise.all(closePromises);
  handlers.length = 0;
  consoleHandler = new ConsoleHandler('info');
  handlers.push(consoleHandler);
}

/**
 * Convenience: create a file handler via the type registry and add it.
 */
export function initFileHandler(filePath: string, type = 'file', level: LogLevel = 'trace'): void {
  const handler = createHandlerByType(type, filePath, level);
  addHandler(handler);
}

// --- Log Level Management (backward compatible) ---

const LEGACY_LEVEL_MAP: Record<LegacyLogLevel, LogLevel | 'silent'> = {
  silent: 'silent',
  info: 'info',
  debug: 'debug',
};

/**
 * Set the console handler's log level.
 * Accepts both new standard levels and legacy 3-level names ('silent', 'info', 'debug').
 */
export function setLogLevel(level: LogLevel | LegacyLogLevel | 'silent'): void {
  const mapped = LEGACY_LEVEL_MAP[level as LegacyLogLevel] ?? level;
  if (mapped !== 'silent' && !VALID_LOG_LEVELS.has(mapped)) {
    throw new Error(`Invalid log level: "${level}". Valid levels: ${[...VALID_LOG_LEVELS].join(', ')}, silent`);
  }
  ensureConsoleHandler().setLevel(mapped as LogLevel | 'silent');
}

/**
 * Get the console handler's current log level.
 */
export function getLogLevel(): LogLevel | 'silent' {
  return ensureConsoleHandler().level;
}

/**
 * Return true if any registered handler will output debug (or lower) entries.
 * Use this instead of getLogLevel() when a file handler may be active at a
 * finer level than the console handler.
 */
export function isDebugEnabled(): boolean {
  return handlers.some((h) => h.level !== 'silent' && LOG_LEVEL_PRIORITY[h.level as LogLevel] >= LOG_LEVEL_PRIORITY['debug']);
}

/**
 * Return true if any registered handler will output trace entries.
 */
export function isTraceEnabled(): boolean {
  return handlers.some((h) => h.level === 'trace');
}

// --- Timestamp ---

export function formatTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
}

// --- Central Log Dispatcher ---

function log(level: LogLevel, tag: string, message: string, data?: unknown): void {
  const entry: LogEntry = {
    timestamp: formatTimestamp(),
    level,
    tag,
    message,
    data,
  };
  for (const handler of handlers) {
    handler.handle(entry);
  }
}

// --- Convenience Wrappers (signatures unchanged for backward compat) ---

/**
 * Log a progress/activity message at info level.
 */
export function logProgress(tag: string, message: string, details?: Record<string, unknown>): void {
  log('info', tag, message, details);
}

/**
 * Log debug information (single line, compact — console truncates at 200 chars).
 */
export function logDebug(tag: string, message: string, data?: unknown): void {
  log('debug', tag, message, data);
}

/**
 * Log debug information without truncation (for full prompts and responses).
 */
export function logDebugFull(tag: string, message: string, data?: string): void {
  log('trace', tag, message, data);
}

/**
 * Log a trace-level message (finer-grained than debug; for raw internal data).
 */
export function logTrace(tag: string, message: string, data?: unknown): void {
  log('trace', tag, message, data);
}

/**
 * Log a warning message.
 */
export function logWarn(tag: string, message: string, data?: unknown): void {
  log('warn', tag, message, data);
}

/**
 * Log an error message.
 */
export function logError(tag: string, message: string, data?: unknown): void {
  log('error', tag, message, data);
}

// --- Timer ---

/**
 * Create a timer for measuring elapsed time.
 */
export function createTimer(): { elapsed: () => number; elapsedStr: () => string } {
  const start = Date.now();
  return {
    elapsed: () => Date.now() - start,
    elapsedStr: () => {
      const ms = Date.now() - start;
      if (ms < 1000) return `${ms}ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
      return `${(ms / 60000).toFixed(2)}m`;
    },
  };
}

// --- Test Helpers ---

/**
 * Reset the handler registry to a clean state (for testing only).
 * Removes all handlers and re-adds a fresh ConsoleHandler.
 */
export async function _resetHandlers(level: LogLevel | 'silent' = 'info'): Promise<void> {
  const closePromises = handlers
    .map((h) => h.close?.())
    .filter(Boolean)
    .map((p) => (p as Promise<void>).catch(() => {}));
  await Promise.all(closePromises);
  handlers.length = 0;
  consoleHandler = new ConsoleHandler(level);
  handlers.push(consoleHandler);
}

/**
 * Get a snapshot of currently registered handler names (for testing only).
 */
export function _getHandlerNames(): string[] {
  return handlers.map((h) => h.name);
}
