/** @format */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function stripQuotes(v: string): string {
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}

/** Parse KEY=VALUE lines (ignoring blanks/comments) into [key, value] pairs. */
function parseEnvLines(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.push([line.slice(0, eq).trim(), stripQuotes(line.slice(eq + 1).trim())]);
  }
  return out;
}

/**
 * Load `.env.smoke` (git-ignored, holds SMOKE_COGNITO_USERNAME/PASSWORD etc.) into
 * process.env for any keys not already set — secrets stay out of the committed
 * `.mcp.json`. Tries the launch cwd (repo root) and the repo root resolved from
 * this file's location. Returns the path loaded, or null if none found.
 */
export function loadEnvSmoke(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), '.env.smoke'),
    join(here, '..', '..', '..', '.env.smoke'),
    join(here, '..', '..', '..', '..', '.env.smoke'),
  ];
  const path = candidates.find(existsSync);
  if (!path) return null;
  for (const [key, val] of parseEnvLines(readFileSync(path, 'utf-8'))) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return path;
}
