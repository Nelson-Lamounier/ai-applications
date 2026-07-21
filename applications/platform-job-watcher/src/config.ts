import * as fs from 'node:fs';
import yaml    from 'js-yaml';

export interface WatcherEntry {
  readonly namespace:         string;
  readonly dbTable:           string;
  readonly staleAfterMinutes: number;
  // Column / value mapping so one watcher serves tables with different
  // schemas. Defaults below match the resume_imports schema, so existing
  // config (namespace + dbTable only) keeps working unchanged.
  readonly statusColumn:      string;       // status column to read + write
  readonly staleColumn:       string;       // timestamp the staleness window is measured from
  readonly errorColumn:       string;       // column the failure marker is written to
  readonly completedColumn:   string;       // timestamp column stamped NOW() on failure
  readonly failedValue:       string;       // value written to statusColumn on failure
  readonly errorValue:        string;       // value written to errorColumn on failure
  readonly terminalStatuses:  readonly string[]; // statuses the sweep must never overwrite
  readonly jobLabelKey:       string;       // Job metadata label whose value = the dbTable row id (event fast path)
  // Optional denormalised-status reconcile. When the primary row is failed, also
  // fail the row it links to (e.g. pipeline_runs.reference_id -> job_applications.id)
  // if that row is still in `linkedFromValue`. Guarded to the primary row's LATEST
  // sibling so a concurrent re-run of the same linked entity is never clobbered.
  // All five must be set together (loadConfig enforces); absent = no linked reconcile.
  readonly linkedTable?:        string;     // e.g. 'job_applications'
  readonly linkedVia?:          string;     // column in dbTable holding linkedTable's id (e.g. 'reference_id')
  readonly linkedStatusColumn?: string;     // status column on linkedTable (e.g. 'kanban_status')
  readonly linkedFromValue?:    string;     // only overwrite when linked row is in this status (e.g. 'analysing')
  readonly linkedToValue?:      string;     // value written to linkedStatusColumn (e.g. 'failed')
}

// Defaults preserve the original resume_imports behaviour.
const ENTRY_DEFAULTS = {
  statusColumn:     'status',
  staleColumn:      'started_at',
  errorColumn:      'error_code',
  completedColumn:  'completed_at',
  failedValue:      'failed',
  errorValue:       'WATCHER_TIMEOUT',
  terminalStatuses: ['completed', 'failed', 'awaiting_upload'] as const,
  jobLabelKey:      'import-id',
} as const;

export interface WatcherConfig {
  readonly watchers: readonly WatcherEntry[];
}

interface RawWatcherEntry {
  namespace:         string;
  dbTable:           string;
  staleAfterMinutes?: number;
  statusColumn?:     string;
  staleColumn?:      string;
  errorColumn?:      string;
  completedColumn?:  string;
  failedValue?:      string;
  errorValue?:       string;
  terminalStatuses?: string[];
  jobLabelKey?:      string;
  linkedTable?:        string;
  linkedVia?:          string;
  linkedStatusColumn?: string;
  linkedFromValue?:    string;
  linkedToValue?:      string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// SQL identifiers (table + column names) are interpolated into the sweep
// UPDATE, so every one must be a strict identifier to prevent injection.
function validateIdentifier(name: string, kind: string): string {
  if (!/^[a-zA-Z_]\w*$/.test(name)) {
    throw new Error(String.raw`Invalid ${kind}: "${name}" — must match /^[a-zA-Z_]\w*$/`);
  }
  return name;
}

// A Kubernetes label key (optional dns-subdomain prefix + name segment). Unlike
// SQL identifiers these legitimately contain '-'/'.'; the value is only ever
// used to index job.metadata.labels, never interpolated into SQL, so this is a
// sanity check, not an injection guard.
function validateLabelKey(key: string): string {
  if (!/^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[a-zA-Z0-9]([-a-zA-Z0-9_.]*[a-zA-Z0-9])?$/.test(key) || key.length > 316) {
    throw new Error(`Invalid jobLabelKey: "${key}" — must be a valid Kubernetes label key`);
  }
  return key;
}

function validateNamespace(ns: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns)) {
    throw new Error(`Invalid Kubernetes namespace: "${ns}" — must match DNS label format`);
  }
  return ns;
}

type LinkedFields = Pick<
  WatcherEntry,
  'linkedTable' | 'linkedVia' | 'linkedStatusColumn' | 'linkedFromValue' | 'linkedToValue'
>;

// Linked-reconcile is all-or-nothing. Table/column names are interpolated into
// the reconcile UPDATE so they must be strict identifiers; the from/to values
// are parameterised, so they pass through unchecked.
function resolveLinked(w: RawWatcherEntry): LinkedFields {
  if (!w.linkedTable) return {};
  if (!w.linkedVia || !w.linkedStatusColumn || !w.linkedFromValue || !w.linkedToValue) {
    throw new Error(
      `Invalid linked-reconcile for "${w.dbTable}": linkedTable requires linkedVia, linkedStatusColumn, linkedFromValue and linkedToValue`,
    );
  }
  return {
    linkedTable:        validateIdentifier(w.linkedTable, 'linkedTable'),
    linkedVia:          validateIdentifier(w.linkedVia, 'linkedVia'),
    linkedStatusColumn: validateIdentifier(w.linkedStatusColumn, 'linkedStatusColumn'),
    linkedFromValue:    w.linkedFromValue,
    linkedToValue:      w.linkedToValue,
  };
}

export function loadConfig(): WatcherConfig {
  const configPath = process.env['WATCHER_CONFIG_PATH'] ?? '/etc/watcher/config.yaml';
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as { watchers: RawWatcherEntry[] };

  if (!Array.isArray(parsed?.watchers) || parsed.watchers.length === 0) {
    throw new Error(`Invalid watcher config at ${configPath}: watchers array missing or empty`);
  }

  return {
    watchers: parsed.watchers.map((w) => ({
      namespace:         validateNamespace(w.namespace),
      dbTable:           validateIdentifier(w.dbTable, 'table name'),
      staleAfterMinutes: w.staleAfterMinutes ?? 15,
      statusColumn:      validateIdentifier(w.statusColumn    ?? ENTRY_DEFAULTS.statusColumn,    'statusColumn'),
      staleColumn:       validateIdentifier(w.staleColumn     ?? ENTRY_DEFAULTS.staleColumn,     'staleColumn'),
      errorColumn:       validateIdentifier(w.errorColumn     ?? ENTRY_DEFAULTS.errorColumn,     'errorColumn'),
      completedColumn:   validateIdentifier(w.completedColumn ?? ENTRY_DEFAULTS.completedColumn, 'completedColumn'),
      failedValue:       w.failedValue      ?? ENTRY_DEFAULTS.failedValue,
      errorValue:        w.errorValue       ?? ENTRY_DEFAULTS.errorValue,
      terminalStatuses:  w.terminalStatuses ?? [...ENTRY_DEFAULTS.terminalStatuses],
      jobLabelKey:       validateLabelKey(w.jobLabelKey ?? ENTRY_DEFAULTS.jobLabelKey),
      ...resolveLinked(w),
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
    port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
    database: required('PG_DATABASE'),
    user:     required('PG_USER'),
    password: required('PG_PASSWORD'),
  };
}
