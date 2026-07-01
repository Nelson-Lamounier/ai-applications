import type { ExtractedRepoData } from '../agents/ProfileExtractor.js';

/**
 * Render each extracted lifecycle event to one retrievable sentence, e.g.
 * "Kubernetes platform: currently Amazon EKS 1.34, migrated 2026-05 from
 * self-managed kubeadm." Deprecated/planned states are framed accordingly so
 * the chatbot leads with the current state and treats the rest as history.
 */
export function renderLifecycleChunks(extracted: ExtractedRepoData): string[] {
    return extracted.lifecycle.map((e) => {
        const when = e.when ? ` ${e.when}` : '';
        if (e.status === 'current') return `${e.system}: currently ${e.to}, migrated${when} from ${e.from}.`;
        if (e.status === 'planned') return `${e.system}: currently ${e.from}; migration to ${e.to} planned${when}.`;
        return `${e.system}: ${e.from} (deprecated${when}), superseded by ${e.to}.`;
    });
}
