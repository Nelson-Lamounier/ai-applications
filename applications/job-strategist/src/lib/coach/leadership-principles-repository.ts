/**
 * @format
 * Read-only repository over the `leadership_principles` ontology (migration 066).
 *
 * Global reference data: no user_id, no RLS, idempotent re-seed. Mirrors
 * `RdsSystemDesignConcernRepository` (migration 065). Each row is a single
 * leadership principle for a framework ('amazon' or 'generic') with curated
 * interpretation, signal keywords, story shapes, probing patterns, and failure
 * modes used by the Bar Raiser coach stage to map project evidence to
 * principles.
 */
import type { Pool } from 'pg';

export type LeadershipFramework = 'amazon' | 'generic';

export interface LeadershipPrinciple {
  principleId: string;
  name: string;
  interpretation: string;
  signalKeywords: string[];
  storyShapes: string[];
  probingPatterns: string[];
  failureModes: string[];
}

/**
 * Map a company name to the leadership-principles framework to evaluate against.
 * Amazon (and AWS) interview on the 16 Leadership Principles; everyone else
 * falls back to the generic set. Whole-word, case-insensitive match so
 * "Amazonian" or "Amazon-like" do not false-positive.
 */
export function frameworkForCompany(company: string): LeadershipFramework {
  return /\bamazon\b/i.test(company) ? 'amazon' : 'generic';
}

interface PrincipleRow {
  principle_id: string;
  name: string;
  interpretation: string;
  signal_keywords: string[];
  story_shapes: string[];
  probing_patterns: string[];
  failure_modes: string[];
}

function toPrinciple(r: PrincipleRow): LeadershipPrinciple {
  return {
    principleId: r.principle_id,
    name: r.name,
    interpretation: r.interpretation,
    signalKeywords: r.signal_keywords ?? [],
    storyShapes: r.story_shapes ?? [],
    probingPatterns: r.probing_patterns ?? [],
    failureModes: r.failure_modes ?? [],
  };
}

/** Read-only repository over the leadership_principles ontology (migration 066). */
export class RdsLeadershipPrinciplesRepository {
  constructor(private readonly pool: Pool) {}

  async load(framework: LeadershipFramework): Promise<LeadershipPrinciple[]> {
    const r = await this.pool.query<PrincipleRow>(
      `SELECT principle_id, name, interpretation, signal_keywords,
              story_shapes, probing_patterns, failure_modes
         FROM leadership_principles
        WHERE framework = $1
        ORDER BY display_order`,
      [framework],
    );
    return r.rows.map(toPrinciple);
  }
}
