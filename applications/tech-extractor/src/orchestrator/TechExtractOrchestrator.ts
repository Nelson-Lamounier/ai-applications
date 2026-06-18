/** @format */
import {
    OntologyResolver, CONFIDENCE_BY_LAYER,
    type TechnologyEvidenceRow, type CandidateUpsertInput,
    type TechnologyEvidenceRepository, type TechnologyCandidateRepository,
} from '@bedrock/shared';
import type { Extractor } from '../extractors/Extractor.js';

export interface OrchestratorRunInput {
    userId:          string;
    repoFullName:    string;
    commitSha:       string;
    rootDir:         string;
    ontologyVersion: number;
    extractors:      Extractor[];
}

export interface OrchestratorResult {
    matched:          number;
    unmatched:        number;
    failedExtractors: string[];
    canonicalIds:     Set<string>;   // distinct matched technology ids (for parity)
}

/** Strip non-alphanumerics for candidate grouping. */
function normalizeForCandidate(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
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
                const techId = this.resolver.resolve(r.raw_name);
                evidence.push({
                    userId: input.userId, repoFullName: input.repoFullName, commitSha: input.commitSha,
                    technologyId: techId, rawName: r.raw_name, ecosystem: r.ecosystem ?? null,
                    sourceLayer: r.source_layer, filePath: r.file_path,
                    lineStart: r.line_start ?? null, lineEnd: r.line_end ?? null,
                    confidence: CONFIDENCE_BY_LAYER[r.source_layer], ontologyVersion: input.ontologyVersion,
                    version: r.version ?? null,
                });
                if (techId) { matched++; canonicalIds.add(techId); }
                else {
                    unmatched++;
                    const norm = normalizeForCandidate(r.raw_name);
                    const key = `${norm}|${r.ecosystem ?? 'unknown'}`;
                    if (!candidatesSeen.has(key)) {
                        candidatesSeen.add(key);
                        pendingCandidates.push({
                            rawName: r.raw_name, normalizedName: norm, ecosystem: r.ecosystem,
                            userId: input.userId, repoFullName: input.repoFullName, filePath: r.file_path,
                        });
                    }
                }
            }
        }

        await Promise.all(pendingCandidates.map((c) => this.candidateRepo.upsert(c)));
        await this.evidenceRepo.insertMany(input.userId, evidence);
        return { matched, unmatched, failedExtractors, canonicalIds };
    }
}
