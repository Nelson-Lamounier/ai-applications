/** @format */
import type { Pool } from 'pg';
import type { SystemDesignConcern } from '../../stage-prep/system-design-concerns-types.js';

interface ConcernRow {
  concern_id: string; category: string; concern_question: string; why_interviewers_ask: string;
  detection_signals: string[]; implementation_patterns: SystemDesignConcern['implementationPatterns'];
  follow_up_questions: string[]; gap_signals: string[]; jd_signal_keywords: string[]; importance: number;
}

function toConcern(r: ConcernRow): SystemDesignConcern {
  return {
    concernId: r.concern_id, category: r.category, concernQuestion: r.concern_question,
    whyInterviewersAsk: r.why_interviewers_ask, detectionSignals: r.detection_signals ?? [],
    implementationPatterns: r.implementation_patterns ?? [], followUpQuestions: r.follow_up_questions ?? [],
    gapSignals: r.gap_signals ?? [], jdSignalKeywords: r.jd_signal_keywords ?? [], importance: r.importance ?? 5,
  };
}

/** Read-only repository over the system_design_concerns ontology (migration 065). */
export class RdsSystemDesignConcernRepository {
  constructor(private readonly pool: Pool) {}
  async listConcerns(): Promise<SystemDesignConcern[]> {
    const r = await this.pool.query<ConcernRow>(
      `SELECT concern_id, category, concern_question, why_interviewers_ask, detection_signals,
              implementation_patterns, follow_up_questions, gap_signals, jd_signal_keywords, importance
         FROM system_design_concerns ORDER BY importance, concern_id`);
    return r.rows.map(toConcern);
  }
}
