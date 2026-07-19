/**
 * @format
 * JD-driven docType relevance — Task 1.
 *
 * Maps PRE-research JD signals (dimensionMix + keyword scans of concepts/
 * responsibilities/retrievalKeywords) to the supplementary `docTypes` set the
 * decision-evidence retrieval pass should gate on: an architecture-heavy JD
 * additionally surfaces ADR (decision) evidence; an ops/SRE-heavy JD
 * additionally surfaces runbook/troubleshooting evidence.
 *
 * Deliberately keys ONLY on fields available before the research agent runs —
 * `dimensionMix.{supportOps,monitoring}` and free-text keyword scans. Never
 * reads `pillarClassification` (a research-agent OUTPUT, not a JD signal).
 *
 * Pure function — no I/O. Returns `{ docTypes: [], angle: null }` when the JD
 * is neither arch- nor ops-heavy (the caller skips the supplementary pass).
 */
import type { JdSignal } from '@bedrock/shared';

/** The canonical docType values this pass ever selects, in the stable order
 *  every non-empty result is filtered/sorted against. */
const STABLE_ORDER = ['adr', 'runbook', 'troubleshooting'] as const;

const OPERATIONS_THRESHOLD = 25;

const OPERATIONS_KEYWORDS = [
    'incident', 'on-call', 'on call', 'observability', 'reliability', 'sre',
    'runbook', 'monitoring', 'postmortem', 'post-mortem', 'sla', 'slo',
];

const ARCHITECTURE_KEYWORDS = [
    'system design', 'architecture', 'architect', 'design decision',
    'trade-off', 'tradeoff', 'scalability', 'distributed system',
    'technical direction', 'rfc', 'adr',
];

export type EvidenceAngle = 'architecture' | 'operations' | 'both' | null;

export interface EvidenceDocTypeSelection {
    readonly docTypes: string[];
    readonly angle: EvidenceAngle;
}

type JdKeywordSignal = Pick<JdSignal, 'dimensionMix' | 'concepts' | 'responsibilities' | 'retrievalKeywords'>;

/** Lowercased concatenation of the free-text JD fields keyword scans run against. */
function keywordHaystack(jd: JdKeywordSignal): string {
    return [...jd.concepts, ...jd.responsibilities, ...jd.retrievalKeywords].join(' \n ').toLowerCase();
}

function matchesAny(haystack: string, keywords: readonly string[]): boolean {
    return keywords.some((k) => haystack.includes(k));
}

/**
 * Derive the supplementary evidence docTypes + angle for a JD.
 *
 * @param jd - The extracted JD signal (dimensionMix + concepts/responsibilities/retrievalKeywords)
 * @returns The docType set (stable-ordered, deduped) and the angle that produced it
 */
export function deriveEvidenceDocTypes(jd: JdKeywordSignal): EvidenceDocTypeSelection {
    const haystack = keywordHaystack(jd);

    const isOperations =
        jd.dimensionMix.supportOps + jd.dimensionMix.monitoring >= OPERATIONS_THRESHOLD ||
        matchesAny(haystack, OPERATIONS_KEYWORDS);

    const isArchitecture = matchesAny(haystack, ARCHITECTURE_KEYWORDS);

    let angle: EvidenceAngle = null;
    if (isOperations && isArchitecture) angle = 'both';
    else if (isOperations) angle = 'operations';
    else if (isArchitecture) angle = 'architecture';

    if (angle === null) return { docTypes: [], angle: null };

    const selected = new Set<string>();
    if (isArchitecture) selected.add('adr');
    if (isOperations) {
        selected.add('runbook');
        selected.add('troubleshooting');
    }

    return {
        docTypes: STABLE_ORDER.filter((t) => selected.has(t)),
        angle,
    };
}
