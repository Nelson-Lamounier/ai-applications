/** @format */
import type { Pool } from 'pg';

export interface DsaTopic {
  readonly canonicalName: string;
  readonly displayName: string;
  readonly category: string;
  readonly jdSignalKeywords: string[];
  readonly prerequisites: string[];
  readonly practicePointer: string | null;
}

interface DsaRow {
  canonical_name: string; display_name: string; category: string;
  jd_signal_keywords: string[]; prerequisites: string[]; practice_pointer: string | null;
}

function toTopic(r: DsaRow): DsaTopic {
  return {
    canonicalName: r.canonical_name, displayName: r.display_name, category: r.category,
    jdSignalKeywords: r.jd_signal_keywords ?? [], prerequisites: r.prerequisites ?? [],
    practicePointer: r.practice_pointer ?? null,
  };
}

/** Read-only repository over the dsa_topics constraint table (migration 051). */
export class RdsDsaTopicRepository {
  constructor(private readonly pool: Pool) {}
  async listTopics(): Promise<DsaTopic[]> {
    const r = await this.pool.query<DsaRow>(
      `SELECT canonical_name, display_name, category, jd_signal_keywords, prerequisites, practice_pointer
         FROM dsa_topics ORDER BY category, canonical_name`);
    return r.rows.map(toTopic);
  }
  async listByCategory(category: string): Promise<DsaTopic[]> {
    const r = await this.pool.query<DsaRow>(
      `SELECT canonical_name, display_name, category, jd_signal_keywords, prerequisites, practice_pointer
         FROM dsa_topics WHERE category = $1 ORDER BY canonical_name`, [category]);
    return r.rows.map(toTopic);
  }
}
