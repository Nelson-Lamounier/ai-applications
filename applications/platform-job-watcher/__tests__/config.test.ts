import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('loadConfig', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-'));
    configFile = path.join(tmpDir, 'config.yaml');
    process.env['WATCHER_CONFIG_PATH'] = configFile;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    delete process.env['WATCHER_CONFIG_PATH'];
  });

  it('parses valid config with resume_imports schema defaults', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: resume-import
    dbTable: resume_imports
`);
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.watchers).toHaveLength(1);
    const w = cfg.watchers[0];
    expect(w.namespace).toBe('resume-import');
    expect(w.dbTable).toBe('resume_imports');
    expect(w.staleAfterMinutes).toBe(15);
    // Defaults preserve the original behaviour.
    expect(w.statusColumn).toBe('status');
    expect(w.staleColumn).toBe('started_at');
    expect(w.errorColumn).toBe('error_code');
    expect(w.completedColumn).toBe('completed_at');
    expect(w.failedValue).toBe('failed');
    expect(w.errorValue).toBe('WATCHER_TIMEOUT');
    expect(w.terminalStatuses).toEqual(['completed', 'failed', 'awaiting_upload']);
    expect(w.jobLabelKey).toBe('import-id');
  });

  it('honours a custom jobLabelKey (hyphenated, non-SQL-identifier)', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: job-strategist
    dbTable: pipeline_runs
    jobLabelKey: pipeline-run-id
`);
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().watchers[0].jobLabelKey).toBe('pipeline-run-id');
  });

  it('rejects an invalid jobLabelKey', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: job-strategist
    dbTable: pipeline_runs
    jobLabelKey: "bad key!"
`);
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/jobLabelKey/);
  });

  it('parses a full linked-reconcile block', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: job-strategist
    dbTable: pipeline_runs
    linkedTable: job_applications
    linkedVia: reference_id
    linkedStatusColumn: kanban_status
    linkedFromValue: analysing
    linkedToValue: failed
`);
    const { loadConfig } = await import('../src/config.js');
    const w = loadConfig().watchers[0];
    expect(w.linkedTable).toBe('job_applications');
    expect(w.linkedVia).toBe('reference_id');
    expect(w.linkedStatusColumn).toBe('kanban_status');
    expect(w.linkedFromValue).toBe('analysing');
    expect(w.linkedToValue).toBe('failed');
  });

  it('rejects a partial linked-reconcile block (all-or-nothing)', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: job-strategist
    dbTable: pipeline_runs
    linkedTable: job_applications
`);
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/linked/i);
  });

  it('leaves linked fields undefined when no linkedTable is set', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: resume-import
    dbTable: resume_imports
`);
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().watchers[0].linkedTable).toBeUndefined();
  });

  it('parses a repo_sync_state entry with custom column mapping', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: ingestion
    dbTable: repo_sync_state
    staleAfterMinutes: 20
    statusColumn: sync_status
    staleColumn: last_sync_triggered_at
    errorColumn: error_message
    completedColumn: updated_at
    failedValue: error
    errorValue: "Ingestion job did not complete in time. Please re-sync."
    terminalStatuses: [complete, error]
`);
    const { loadConfig } = await import('../src/config.js');
    const w = loadConfig().watchers[0];
    expect(w.dbTable).toBe('repo_sync_state');
    expect(w.statusColumn).toBe('sync_status');
    expect(w.staleColumn).toBe('last_sync_triggered_at');
    expect(w.errorColumn).toBe('error_message');
    expect(w.completedColumn).toBe('updated_at');
    expect(w.failedValue).toBe('error');
    expect(w.terminalStatuses).toEqual(['complete', 'error']);
  });

  it('rejects a column name that is not a safe SQL identifier', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: ingestion
    dbTable: repo_sync_state
    statusColumn: "sync_status; DROP TABLE users"
`);
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/statusColumn/);
  });

  it('throws when config file is missing', async () => {
    process.env['WATCHER_CONFIG_PATH'] = '/nonexistent/config.yaml';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow();
  });

  it('throws when watchers array is empty', async () => {
    fs.writeFileSync(configFile, 'watchers: []\n');
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('Invalid watcher config');
  });
});
