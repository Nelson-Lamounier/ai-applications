/** @format */
import type { DirectionJson, ReconciliationJson } from '../rds/interfaces/IUserProfileRollupRepository.js';

/**
 * Render the JD-relevant slices of a user's "Profile Intelligence" (the
 * code-grounded synthesis produced on repo sync) into a compact prompt block for
 * the research + strategist agents.
 *
 * Three sections, each from an independently-grounded synthesizer:
 *  - Code-demonstrated DIRECTION (archetypes + per-area seniority) — framed as a
 *    SEPARATE, demonstrated signal to weigh ALONGSIDE résumé-stated seniority
 *    (never to override it here).
 *  - UNDERSOLD strengths — real GitHub strengths the résumé under-represents →
 *    surface where the JD values them.
 *  - UNSUPPORTED claims — résumé statements the code does not back → an
 *    anti-inflation guardrail (do not present as demonstrated production work).
 *
 * Pure + deterministic. Returns '' when there's nothing grounded (callers
 * fail-open). All of this is already filtered to grounded items upstream by the
 * synthesizers; this only formats + caps.
 */
export interface ProfileIntelligenceInput {
  readonly direction: DirectionJson | null;
  readonly reconciliation: ReconciliationJson | null;
}

export interface FormatProfileIntelligenceOptions {
  readonly maxArchetypes?: number;   // default 4
  readonly maxUndersold?: number;    // default 6
  readonly maxUnsupported?: number;  // default 5
}

const FIT_RANK: Readonly<Record<string, number>> = { strong: 0, moderate: 1, weak: 2 };

function clip(text: string, max = 240): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function directionLines(direction: DirectionJson | null, maxArchetypes: number): string[] {
  if (!direction) return [];
  const out: string[] = [];
  // Strongest-fit archetypes first; drop 'weak' (not a positioning signal).
  const ranked = [...direction.archetypes]
    .filter((a) => a.fit !== 'weak')
    .sort((a, b) => (FIT_RANK[a.fit] ?? 9) - (FIT_RANK[b.fit] ?? 9))
    .slice(0, maxArchetypes);
  if (ranked.length > 0) {
    out.push(`   Strongest areas (code-demonstrated): ${ranked.map((a) => `${a.archetype} (${a.fit})`).join(', ')}`);
  }
  if (direction.seniority.length > 0) {
    out.push(`   Code-demonstrated seniority: ${direction.seniority.map((s) => `${s.area} — ${s.level}`).join('; ')}`);
    out.push('   (Demonstrated by their repositories — weigh ALONGSIDE résumé-stated seniority, do not discard either.)');
  }
  return out;
}

function undersoldLines(recon: ReconciliationJson | null, max: number): string[] {
  const items = recon?.undersold ?? [];
  if (items.length === 0) return [];
  const out = ['', 'Strengths their résumé under-represents — surface these where the JD values them:'];
  for (const u of items.slice(0, max)) out.push(`   - ${clip(u.evidence, 200)} → ${clip(u.suggestion, 200)}`);
  return out;
}

function unsupportedLines(recon: ReconciliationJson | null, max: number): string[] {
  const items = recon?.unsupportedClaims ?? [];
  if (items.length === 0) return [];
  const out = ['', 'Résumé claims their code does NOT substantiate — do NOT present these as demonstrated production work:'];
  for (const c of items.slice(0, max)) out.push(`   - ${clip(c.claim, 200)} (résumé: ${clip(c.resumeRef, 80)}) — ${clip(c.whyUnsupported, 160)}`);
  return out;
}

export function formatProfileIntelligence(
  input: ProfileIntelligenceInput,
  opts: FormatProfileIntelligenceOptions = {},
): string {
  const dir   = directionLines(input.direction, opts.maxArchetypes ?? 4);
  const under = undersoldLines(input.reconciliation, opts.maxUndersold ?? 6);
  const unsup = unsupportedLines(input.reconciliation, opts.maxUnsupported ?? 5);
  if (dir.length === 0 && under.length === 0 && unsup.length === 0) return '';

  const header = [
    'CANDIDATE PROFILE INTELLIGENCE — derived from the candidate\'s own GitHub (grounded in their code, independent of the résumé).',
    'Use it to surface code-backed strengths and to avoid leaning on claims the code does not support.',
  ];
  const dirHeader = dir.length > 0 ? ['', 'Code-demonstrated direction:'] : [];
  return [...header, ...dirHeader, ...dir, ...under, ...unsup].join('\n');
}
