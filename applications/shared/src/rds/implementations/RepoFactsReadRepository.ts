/** @format */
import type { Pool } from 'pg';

/** One technology/tool entry within a `repo_facts` lane (migration 121). */
export interface RepoFactEntry {
    readonly name: string;
    readonly version: string | null;
    readonly evidenceCount: number;
}

/**
 * One `repo_facts` concept entry — either detector-backed (a real `detector`
 * name and `files` count, from `concept_evidence`) or the legacy signal-derived
 * fallback (`detector: 'signal'`, `files: 0`). See
 * `applications/ingestion/src/facts/build-repo-facts.ts` for how these are
 * assembled.
 */
export interface RepoFactConceptEntry {
    readonly name: string;
    readonly detector: string;
    readonly files: number;
}

/**
 * The `repo_facts.facts` JSONB payload shape (mirrors ingestion's
 * `RepoFactsPayload` in `build-repo-facts.ts` — duplicated here rather than
 * imported, since `shared` cannot depend on `ingestion`).
 */
export interface RepoFactsPayload {
    readonly languages: RepoFactEntry[];
    readonly frameworks: RepoFactEntry[];
    readonly databases: RepoFactEntry[];
    readonly infrastructure: RepoFactEntry[];
    readonly tools: RepoFactEntry[];
    readonly concepts: RepoFactConceptEntry[];
}

/** One `repo_facts` row (migration 121) — a user's materialised per-repo fact sheet. */
export interface RepoFactRow {
    readonly repoFullName: string;
    readonly role: string;
    readonly classification: string | null;
    readonly facts: RepoFactsPayload;
}

/**
 * Reads a user's materialised `repo_facts` fact sheets (migration 121) — one
 * row per repo: languages/frameworks/databases/infrastructure/tools with
 * per-technology evidence counts, plus detector-backed concepts. Built once
 * per Job (ingestion's `build-repo-facts.ts`), so this is a plain read-only
 * per-user query — no set_config needed, mirroring
 * `SkillOntologyRepository.loadRepoConcepts`'s exact connection pattern (the
 * connecting role reads across RLS, same convention as that per-user evidence
 * loader).
 */
export class RepoFactsReadRepository {
    constructor(private readonly pool: Pool) {}

    /** Empty array when the user has no fact sheets yet (callers fail-open). */
    async loadForUser(userId: string): Promise<RepoFactRow[]> {
        const { rows } = await this.pool.query<{
            repo_full_name: string;
            role: string;
            classification: string | null;
            facts: RepoFactsPayload;
        }>(
            `SELECT repo_full_name, role, classification, facts
               FROM repo_facts
              WHERE user_id = $1`,
            [userId],
        );
        return rows.map((r) => ({
            repoFullName:   r.repo_full_name,
            role:           r.role,
            classification: r.classification,
            facts:          r.facts,
        }));
    }
}
