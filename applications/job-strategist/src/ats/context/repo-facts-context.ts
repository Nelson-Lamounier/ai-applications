/**
 * @format
 * Repo Fact Sheet Context Builder — Task 5.
 *
 * Builds a short LLM-readable context string from a user's materialised
 * `repo_facts` fact sheets (migration 121, read via
 * `RepoFactsReadRepository.loadForUser`): one compact line per repo listing
 * its languages/frameworks/databases/infrastructure/tools and detector-backed
 * concepts, each capped and lanes omitted when empty — the same "never dump
 * the full ontology into the prompt" discipline as `formatTechTransferContext`
 * / `formatConceptEvidenceContext`. Forked/noise repos are excluded so the
 * matcher never grounds a claim in a repo that isn't the candidate's own work.
 *
 * Injection-surface discipline: only technology/concept NAMES and evidence
 * COUNTS are rendered — never file paths.
 *
 * Pure function — no I/O. Returns '' when no repo is eligible.
 */
import type { RepoFactRow, RepoFactsPayload, RepoFactEntry, RepoFactConceptEntry } from '@bedrock/shared';

export type { RepoFactRow, RepoFactsPayload, RepoFactEntry, RepoFactConceptEntry };

const LANE_CAP = 6;
const EXCLUDED_CLASSIFICATIONS = new Set(['fork', 'noise']);

interface TechLane {
    readonly label: string;
    readonly entries: RepoFactEntry[];
}

/** `label: name, name, ...` — names only, capped, or '' when the lane is empty. */
function formatTechLane(lane: TechLane): string {
    if (lane.entries.length === 0) return '';
    const names = lane.entries.slice(0, LANE_CAP).map((e) => e.name);
    return `${lane.label}: ${names.join(', ')}`;
}

/** `concepts: name (N files), ...` — capped, or '' when there are no concepts. */
function formatConceptsLane(entries: RepoFactConceptEntry[]): string {
    if (entries.length === 0) return '';
    const parts = entries.slice(0, LANE_CAP).map((e) => `${e.name} (${e.files} files)`);
    return `concepts: ${parts.join(', ')}`;
}

function formatRepoLine(row: RepoFactRow): string {
    const lanes: TechLane[] = [
        { label: 'languages', entries: row.facts.languages },
        { label: 'frameworks', entries: row.facts.frameworks },
        { label: 'databases', entries: row.facts.databases },
        { label: 'infrastructure', entries: row.facts.infrastructure },
        { label: 'tools', entries: row.facts.tools },
    ];
    const segments = [
        ...lanes.map(formatTechLane),
        formatConceptsLane(row.facts.concepts),
    ].filter((s) => s.length > 0);
    return `- ${row.repoFullName} (${row.role}): ${segments.join('; ')}`;
}

/**
 * Build a short "what each repo IS" fact-sheet block for the research
 * agent — deterministic, evidence-counted, and independent of the
 * `RepoProfile` (structural) / `formatConceptEvidenceContext` (JD-filtered
 * concept) blocks it sits alongside.
 *
 * @param rows - The user's `repo_facts` rows (all repos, unfiltered by JD)
 * @returns Formatted context string, or '' when no repo is eligible
 */
export function formatRepoFactsContext(rows: RepoFactRow[]): string {
    const eligible = rows.filter((r) => !EXCLUDED_CLASSIFICATIONS.has((r.classification ?? '').toLowerCase()));
    if (eligible.length === 0) return '';

    const lines = eligible.map(formatRepoLine);
    return ['## Repo Fact Sheets', ...lines].join('\n');
}
