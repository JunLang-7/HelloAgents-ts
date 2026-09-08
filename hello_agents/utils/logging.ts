/** Small standard-library-style logger used by the learn-version utilities. */

import { format as nodeFormat } from 'node:util';

export type LogLevel = 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | string;

const LEVELS: Record<string, number> = {
  CRITICAL: 50,
  ERROR: 40,
  WARNING: 30,
  INFO: 20,
  DEBUG: 10,
  NOTSET: 0
};

export interface LoggerHandler {
  readonly stream: 'stdout';
  readonly formatString: string;
}

/**
 * The subset of Python's Logger API used by HelloAgents.
 *
 * `handlers` and `level` are exposed as read-only views to make the object
 * useful in tests while keeping configuration in `setupLogger`.
 */
export class Logger {
  public readonly name: string;
  public level: number;
  public readonly handlers: LoggerHandler[] = [];
  private formatString = '%(asctime)s - %(name)s - %(levelname)s - %(message)s';

  public constructor(name: string) {
    this.name = name;
    // Python's unconfigured logger inherits WARNING from the root logger.
    this.level = LEVELS.WARNING!;
  }

  public setLevel(level: number | string): void {
    this.level = levelNumber(level);
  }

  public debug(message: unknown, ...args: unknown[]): void {
    this.write('DEBUG', message, args);
  }

  public info(message: unknown, ...args: unknown[]): void {
    this.write('INFO', message, args);
  }

  public warning(message: unknown, ...args: unknown[]): void {
    this.write('WARNING', message, args);
  }

  /** Alias retained for the common JavaScript spelling. */
  public warn(message: unknown, ...args: unknown[]): void {
    this.warning(message, ...args);
  }

  public error(message: unknown, ...args: unknown[]): void {
    this.write('ERROR', message, args);
  }

  public critical(message: unknown, ...args: unknown[]): void {
    this.write('CRITICAL', message, args);
  }

  public log(level: number | string, message: unknown, ...args: unknown[]): void {
    const levelName = typeof level === 'string' ? level.toUpperCase() : levelNameFor(level);
    this.write(levelName, message, args);
  }

  private write(levelName: string, message: unknown, args: unknown[]): void {
    const numericLevel = levelNumber(levelName);
    if (numericLevel < this.level) return;
    const renderedMessage =
      args.length > 0 ? nodeFormat(String(message), ...args) : String(message);
    const now = new Date();
    const asctime = `${now.getFullYear().toString().padStart(4, '0')}-${(now.getMonth() + 1)
      .toString()
      .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now
      .getHours()
      .toString()
      .padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now
      .getSeconds()
      .toString()
      .padStart(2, '0')},${now.getMilliseconds().toString().padStart(3, '0')}`;
    const output = this.formatString
      .replaceAll('%(asctime)s', asctime)
      .replaceAll('%(name)s', this.name)
      .replaceAll('%(levelname)s', levelName)
      .replaceAll('%(message)s', renderedMessage);
    // Python's StreamHandler(sys.stdout) writes one line to stdout.
    console.log(output);
  }

  /** Internal configuration hook used by setupLogger. */
  public configure(formatString: string): void {
    this.formatString = formatString;
    if (this.handlers.length === 0) {
      this.handlers.push({ stream: 'stdout', formatString });
    }
  }
}

function levelNumber(level: number | string): number {
  if (typeof level === 'number' && Number.isFinite(level)) return level;
  const normalized = String(level).toUpperCase();
  const value = LEVELS[normalized];
  if (value === undefined) throw new Error(`Unknown log level: ${String(level)}`);
  return value;
}

function levelNameFor(level: number): string {
  return Object.entries(LEVELS).find(([, value]) => value === level)?.[0] ?? String(level);
}

const loggers = new Map<string, Logger>();

/** Configure and return a named logger, matching Python setup_logger. */
export function setupLogger(name = 'hello_agents', level = 'INFO', formatString?: string): Logger {
  const logger = getLogger(name);
  logger.setLevel(level);
  if (logger.handlers.length === 0) {
    logger.configure(formatString ?? '%(asctime)s - %(name)s - %(levelname)s - %(message)s');
  }
  return logger;
}

/** Return a stable logger object without adding a handler. */
export function getLogger(name = 'hello_agents'): Logger {
  let logger = loggers.get(name);
  if (!logger) {
    logger = new Logger(name);
    loggers.set(name, logger);
  }
  return logger;
}

// Python-compatible spellings.
export const setup_logger = setupLogger;
export const get_logger = getLogger;
