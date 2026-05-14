/**
 * @format
 * Tests for public-api lib/config.ts
 *
 * Verifies fail-fast startup validation and correct mapping of
 * environment variables to the typed Config interface.
 */

import { loadConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ENV: Record<string, string> = {
  AWS_DEFAULT_REGION: 'eu-west-1',
  PG_HOST:     'pgbouncer.platform.svc.cluster.local',
  PG_PORT:     '5432',
  PG_DATABASE: 'platform',
  PG_USER:     'public_api',
  PG_PASSWORD: 'super-secret',
};

function setEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
}

function unsetEnv(keys: string[]): void {
  for (const k of keys) {
    delete process.env[k];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadConfig()', () => {
  beforeEach(() => setEnv(VALID_ENV));
  afterEach(() => unsetEnv([
    ...Object.keys(VALID_ENV),
    'PORT',
    'BEDROCK_PUBLIC_API_URL',
    'BEDROCK_AUTH_API_URL',
  ]));

  describe('happy path', () => {
    it('returns typed config when all required vars are present', () => {
      const cfg = loadConfig();

      expect(cfg.awsRegion).toBe('eu-west-1');
      expect(cfg.pgHost).toBe('pgbouncer.platform.svc.cluster.local');
      expect(cfg.pgPort).toBe(5432);
      expect(cfg.pgDatabase).toBe('platform');
      expect(cfg.pgUser).toBe('public_api');
      expect(cfg.pgPassword).toBe('super-secret');
    });

    it('defaults pgPort to 5432 when PG_PORT is absent', () => {
      delete process.env['PG_PORT'];
      const cfg = loadConfig();
      expect(cfg.pgPort).toBe(5432);
    });

    it('defaults port to 3001 when PORT is not set', () => {
      const cfg = loadConfig();
      expect(cfg.port).toBe(3001);
    });

    it('reads port from PORT env var', () => {
      process.env['PORT'] = '9000';
      const cfg = loadConfig();
      expect(cfg.port).toBe(9000);
    });

    it('returns a frozen config object', () => {
      const cfg = loadConfig();
      expect(Object.isFrozen(cfg)).toBe(true);
    });

    it('bedrockPublicApiUrl is undefined when BEDROCK_PUBLIC_API_URL is absent', () => {
      const cfg = loadConfig();
      expect(cfg.bedrockPublicApiUrl).toBeUndefined();
    });

    it('reads bedrockPublicApiUrl from BEDROCK_PUBLIC_API_URL', () => {
      process.env['BEDROCK_PUBLIC_API_URL'] = 'https://api.example.com/v1/invoke-public';
      const cfg = loadConfig();
      expect(cfg.bedrockPublicApiUrl).toBe('https://api.example.com/v1/invoke-public');
    });

    it('bedrockAuthApiUrl is undefined when BEDROCK_AUTH_API_URL is absent', () => {
      const cfg = loadConfig();
      expect(cfg.bedrockAuthApiUrl).toBeUndefined();
    });

    it('reads bedrockAuthApiUrl from BEDROCK_AUTH_API_URL', () => {
      process.env['BEDROCK_AUTH_API_URL'] = 'https://api.example.com/v1/invoke-authenticated';
      const cfg = loadConfig();
      expect(cfg.bedrockAuthApiUrl).toBe('https://api.example.com/v1/invoke-authenticated');
    });
  });

  describe('fail-fast validation', () => {
    it('does not throw when AWS_DEFAULT_REGION is missing — Lambda injects AWS_REGION', () => {
      delete process.env['AWS_DEFAULT_REGION'];
      expect(() => loadConfig()).not.toThrow();
    });

    it('throws when PG_HOST is missing', () => {
      delete process.env['PG_HOST'];
      expect(() => loadConfig()).toThrow('PG_HOST');
    });

    it('throws when PG_DATABASE is missing', () => {
      delete process.env['PG_DATABASE'];
      expect(() => loadConfig()).toThrow('PG_DATABASE');
    });

    it('throws when PG_USER is missing', () => {
      delete process.env['PG_USER'];
      expect(() => loadConfig()).toThrow('PG_USER');
    });

    it('throws when PG_PASSWORD is missing', () => {
      delete process.env['PG_PASSWORD'];
      expect(() => loadConfig()).toThrow('PG_PASSWORD');
    });

    it('lists all missing variables in a single error', () => {
      unsetEnv(['PG_USER', 'PG_PASSWORD']);
      expect(() => loadConfig()).toThrow(/PG_USER/);
      expect(() => loadConfig()).toThrow(/PG_PASSWORD/);
    });

    it('mentions the platform-rds-credentials secret in the error', () => {
      delete process.env['PG_HOST'];
      expect(() => loadConfig()).toThrow(/platform-rds-credentials/);
    });
  });
});
