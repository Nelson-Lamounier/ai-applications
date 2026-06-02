/** @format */
import type { Pool } from 'pg';

export interface AiTopic {
  readonly canonicalName: string;
  readonly displayName: string;
  readonly category: string;
  readonly jdSignalKeywords: string[];
}

interface AiRow {
  canonical_name: string; display_name: string; category: string;
  jd_signal_keywords: string[];
}

function toTopic(r: AiRow): AiTopic {
  return {
    canonicalName: r.canonical_name, displayName: r.display_name, category: r.category,
    jdSignalKeywords: r.jd_signal_keywords ?? [],
  };
}

/** Read-only repository over the ai_topics constraint table (migration 057). */
export class RdsAiTopicRepository {
  constructor(private readonly pool: Pool) {}

  /** Returns all canonical names — used by the AI lane in run-tech-extract. */
  async listCanonicalNames(): Promise<string[]> {
    const r = await this.pool.query<{ canonical_name: string }>(
      `SELECT canonical_name FROM ai_topics ORDER BY canonical_name`);
    return r.rows.map((row) => row.canonical_name);
  }

  async listTopics(): Promise<AiTopic[]> {
    const r = await this.pool.query<AiRow>(
      `SELECT canonical_name, display_name, category, jd_signal_keywords
         FROM ai_topics ORDER BY category, canonical_name`);
    return r.rows.map(toTopic);
  }

  async listByCategory(category: string): Promise<AiTopic[]> {
    const r = await this.pool.query<AiRow>(
      `SELECT canonical_name, display_name, category, jd_signal_keywords
         FROM ai_topics WHERE category = $1 ORDER BY canonical_name`, [category]);
    return r.rows.map(toTopic);
  }
}
