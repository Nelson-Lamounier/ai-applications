/** @format */
import { CONFIDENCE_BY_LAYER } from '@bedrock/shared';
import type {
    OntologyResolver, TechnologyEvidenceRow, CandidateUpsertInput,
    TechnologyEvidenceRepository, TechnologyCandidateRepository,
} from '@bedrock/shared';
import type { Extractor, RawTechnologyEvidence } from './extractors/Extractor.js';

export interface OrchestratorRunInput {
    userId:          string;
    repoFullName:    string;
    commitSha:       string;
    rootDir:         string;
    ontologyVersion: number;
    extractors:      Extractor[];
    /** Immutable GitHub repo id (rename-safe key); null when unknown. */
    githubRepoId:    number | null;
    /**
     * Skip `candidateRepo.upsert` and `evidenceRepo.insertMany` — still
     * extract, resolve, and return `rows`/`canonicalIds` as normal. Used by
     * the UNIFIED_INGESTION shadow gate (spec P1): it needs the would-be
     * evidence rows for parity comparison without writing anything.
     */
    dryRun?: boolean;
}

export interface OrchestratorResult {
    matched:          number;
    unmatched:        number;
    failedExtractors: string[];
    canonicalIds:     Set<string>;   // distinct matched technology ids (for parity)
    /** Every resolved evidence row (matched + unmatched), same shape persisted
     *  to `technology_evidence`. Populated whether or not `dryRun` was set. */
    rows:             TechnologyEvidenceRow[];
}

/** Strip non-alphanumerics for candidate grouping. */
function normalizeForCandidate(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface ResolvedRow {
    readonly evidence:  TechnologyEvidenceRow;
    readonly candidate: CandidateUpsertInput | null; // null when the row matched the ontology
}

/** Resolve one raw extractor row against the ontology and shape it for persistence. */
function resolveRow(resolver: OntologyResolver, input: OrchestratorRunInput, r: RawTechnologyEvidence): ResolvedRow {
    const technologyId = resolver.resolve(r.raw_name);
    const evidence: TechnologyEvidenceRow = {
        userId: input.userId, repoFullName: input.repoFullName, commitSha: input.commitSha,
        technologyId, rawName: r.raw_name, ecosystem: r.ecosystem ?? null,
        sourceLayer: r.source_layer, filePath: r.file_path,
        lineStart: r.line_start ?? null, lineEnd: r.line_end ?? null,
        confidence: CONFIDENCE_BY_LAYER[r.source_layer], ontologyVersion: input.ontologyVersion,
        version: r.version ?? null,
        githubRepoId: input.githubRepoId,
    };
    if (technologyId) return { evidence, candidate: null };
    return {
        evidence,
        candidate: {
            rawName: r.raw_name, normalizedName: normalizeForCandidate(r.raw_name), ecosystem: r.ecosystem,
            userId: input.userId, repoFullName: input.repoFullName, filePath: r.file_path,
        },
    };
}

export class TechExtractOrchestrator {
    constructor(
        private readonly resolver: OntologyResolver,
        private readonly evidenceRepo: TechnologyEvidenceRepository,
        private readonly candidateRepo: TechnologyCandidateRepository,
    ) {}

    async run(input: OrchestratorRunInput): Promise<OrchestratorResult> {
        const failedExtractors: string[] = [];
        const settled = await Promise.allSettled(
            input.extractors.map(async (e) => ({ name: e.name, rows: await e.extract(input.rootDir) })),
        );

        const evidence: TechnologyEvidenceRow[] = [];
        const canonicalIds = new Set<string>();
        const candidatesSeen = new Set<string>();
        const pendingCandidates: CandidateUpsertInput[] = [];
        let matched = 0, unmatched = 0;

        for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            if (s.status === 'rejected') { failedExtractors.push(input.extractors[i].name); continue; }
            for (const r of s.value.rows) {
                const resolved = resolveRow(this.resolver, input, r);
                evidence.push(resolved.evidence);
                if (!resolved.candidate) { matched++; canonicalIds.add(resolved.evidence.technologyId as string); continue; }
                unmatched++;
                const key = `${resolved.candidate.normalizedName}|${resolved.candidate.ecosystem ?? 'unknown'}`;
                if (candidatesSeen.has(key)) continue;
                candidatesSeen.add(key);
                pendingCandidates.push(resolved.candidate);
            }
        }

        if (!input.dryRun) {
            await Promise.all(pendingCandidates.map((c) => this.candidateRepo.upsert(c)));
            await this.evidenceRepo.insertMany(input.userId, evidence);
        }
        return { matched, unmatched, failedExtractors, canonicalIds, rows: evidence };
    }
}
