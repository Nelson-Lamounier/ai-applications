/**
 * @format
 * Free-tier evidence gather — the grounded inputs for the narrative writer.
 * RAG (hybrid + rerank + citations) over the JD-derived queries, plus project
 * case studies, extracted technologies, and verbatim career/education facts.
 * NO matcher, NO skill-evidence ledger.
 */
import type { Pool } from 'pg';
import { TechnologyOntologyRepository } from '@bedrock/shared';
import type { JdSignal } from '@bedrock/shared';
import type { StrategistEnv } from '../env.js';
import { jdRetrievalQueries } from '../agents/jd-extractor.js';
import { loadProjectEvidenceBlock } from '../agents/project-evidence-block.js';
import {
    loadCareerHistory,
    formatExperienceFacts,
    loadEducation,
    formatEducation,
} from '../agents/career-history.js';
import { buildCodeStackContext } from '../ats/code-truth.js';

export interface FreeEvidence {
    readonly kbPassages: string[];
    readonly projectEvidence: string;
    readonly extractedTech: string;
    readonly careerFacts: string;
    readonly educationFacts: string;
}

export interface GatherDeps {
    retrieve(query: string): Promise<string[]>;
}

export async function gatherFreeEvidence(
    pool: Pool,
    env: StrategistEnv,
    jdSignal: JdSignal,
    deps: GatherDeps,
): Promise<FreeEvidence> {
    const q = jdRetrievalQueries(jdSignal);

    const [passageGroups, projectEvidence, careerEntries, educationEntries, codeTechByRepo] =
        await Promise.all([
            Promise.all([
                deps.retrieve(q.skill),
                deps.retrieve(q.experience),
                deps.retrieve(q.project),
            ]),
            loadProjectEvidenceBlock(pool, env.userId),
            loadCareerHistory(pool, env.userId).catch(() => []),
            loadEducation(pool, env.userId).catch(() => []),
            new TechnologyOntologyRepository(pool)
                .loadRepoCodeTech(env.userId)
                .catch(() => new Map<string, Set<string>>()),
        ]);

    const kbPassages = passageGroups.flat();
    const extractedTech = buildCodeStackContext(codeTechByRepo);
    const careerFacts = formatExperienceFacts(careerEntries);
    const educationFacts = formatEducation(educationEntries);

    return { kbPassages, projectEvidence, extractedTech, careerFacts, educationFacts };
}
