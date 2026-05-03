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

  it('parses valid config with defaults', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: resume-import
    dbTable: resume_imports
`);
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.watchers).toHaveLength(1);
    expect(cfg.watchers[0]!.namespace).toBe('resume-import');
    expect(cfg.watchers[0]!.dbTable).toBe('resume_imports');
    expect(cfg.watchers[0]!.staleAfterMinutes).toBe(15);
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
