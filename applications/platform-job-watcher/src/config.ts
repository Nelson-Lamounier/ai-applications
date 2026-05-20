import * as fs from 'node:fs';
import yaml    from 'js-yaml';

export interface WatcherEntry {
  readonly namespace:         string;
  readonly dbTable:           string;
  readonly staleAfterMinutes: number;
}

export interface WatcherConfig {
  readonly watchers: readonly WatcherEntry[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function validateTableName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name: "${name}" — must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
  }
  return name;
}

function validateNamespace(ns: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns)) {
    throw new Error(`Invalid Kubernetes namespace: "${ns}" — must match DNS label format`);
  }
  return ns;
}

export function loadConfig(): WatcherConfig {
  const configPath = process.env['WATCHER_CONFIG_PATH'] ?? '/etc/watcher/config.yaml';
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as { watchers: Array<{ namespace: string; dbTable: string; staleAfterMinutes?: number }> };

  if (!Array.isArray(parsed?.watchers) || parsed.watchers.length === 0) {
    throw new Error(`Invalid watcher config at ${configPath}: watchers array missing or empty`);
  }

  return {
    watchers: parsed.watchers.map((w) => ({
      namespace:         validateNamespace(w.namespace),
      dbTable:           validateTableName(w.dbTable),
      staleAfterMinutes: w.staleAfterMinutes ?? 15,
    })),
  };
}

export interface DbConfig {
  readonly host:     string;
  readonly port:     number;
  readonly database: string;
  readonly user:     string;
  readonly password: string;
}

export function loadDbConfig(): DbConfig {
  return {
    host:     required('PG_HOST'),
    port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
    database: required('PG_DATABASE'),
    user:     required('PG_USER'),
    password: required('PG_PASSWORD'),
  };
}
