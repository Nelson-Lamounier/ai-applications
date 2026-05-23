/**
 * @format
 * Shared structured-logger accessor for leaf modules.
 *
 * Leaf modules (parsers, embedders, per-role helpers) run deep inside a Job's
 * call tree and don't receive the bootstrap logger by argument. Reaching for
 * `console.log(msg, obj)` there is a trap: Node renders the object argument as
 * a *multi-line* pretty dump, which Loki's `| json` pipeline cannot parse — the
 * lines surface as `JSONParserErr` and vanish from every dashboard log panel.
 *
 * `jobLogger()` resolves the pino logger published on globalThis by
 * bootstrapK8sObservability() (pino emits one JSON object per line). When no
 * bootstrap has run (unit tests, ad-hoc scripts) it falls back to a console
 * shim that *still* emits single-line JSON, so log output is Loki-safe
 * everywhere.
 */
import type { Logger as PinoLogger } from 'pino';

/** Minimal structured-logger surface used by leaf modules. */
export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

function singleLineConsole(): JobLogger {
  const emit = (level: string, obj: object, msg: string): void => {
    // One JSON object per line — never pass `obj` as a second console arg, or
    // Node pretty-prints it across multiple lines and breaks Loki `| json`.
    process.stdout.write(`${JSON.stringify({ level, msg, ...obj })}\n`);
  };
  return {
    info:  (obj, msg) => emit('info', obj, msg),
    warn:  (obj, msg) => emit('warn', obj, msg),
    error: (obj, msg) => emit('error', obj, msg),
  };
}

/**
 * Returns the bootstrap pino logger if observability has been initialised,
 * otherwise a single-line-JSON console fallback. Safe to call from any module.
 */
export function jobLogger(): JobLogger {
  const log = (globalThis as { __obsHandle?: { logger: PinoLogger } }).__obsHandle?.logger;
  return log ?? singleLineConsole();
}
