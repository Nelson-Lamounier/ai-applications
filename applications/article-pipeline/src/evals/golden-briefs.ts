/**
 * @format
 * Golden research briefs for the WRITER-phase live eval. Typed (not JSON) so the
 * ResearchResult contract is compile-checked. Kept small and self-contained —
 * the writer eval grades structure/style/coverage, which does not need a real
 * user KB, so these briefs carry their own synthetic outline + facts.
 */
import type { ComplexityAnalysis, ResearchResult } from '@bedrock/shared';

const LOW_COMPLEXITY: ComplexityAnalysis = {
    tier: 'LOW',
    budgetTokens: 2048,
    reason: 'eval fixture',
    signals: { charCount: 0, codeBlockCount: 0, codeRatio: 0, yamlFrontmatterBlocks: 0, uniqueHeadingCount: 0 },
};

export interface GoldenBrief {
    readonly id: string;
    readonly research: ResearchResult;
}

export const GOLDEN_BRIEFS: ReadonlyArray<GoldenBrief> = [
    {
        id: 'eks-argocd',
        research: {
            mode: 'kb-augmented',
            draftContent: 'Write about bootstrapping EKS with ArgoCD and Helm.',
            complexity: LOW_COMPLEXITY,
            kbPassages: [],
            outline: [
                { heading: 'Why GitOps', wordBudget: 200, keyPoints: ['pull-based delivery'], needsVisual: false },
                { heading: 'Bootstrapping the cluster', wordBudget: 300, keyPoints: ['ArgoCD app-of-apps'], needsVisual: true },
                { heading: 'Keeping it in sync', wordBudget: 200, keyPoints: ['self-heal', 'drift'], needsVisual: false },
            ],
            technicalFacts: ['ArgoCD reconciles desired state from Git', 'Helm charts package the workloads'],
            suggestedTitle: 'Bootstrapping EKS with ArgoCD',
            suggestedTags: ['kubernetes', 'argocd', 'gitops'],
            authorDirection: 'Practical, first-person, UK English.',
        },
    },
    {
        id: 'rag-pipeline',
        research: {
            mode: 'kb-augmented',
            draftContent: 'Write about a RAG ingestion pipeline with pgvector.',
            complexity: LOW_COMPLEXITY,
            kbPassages: [],
            outline: [
                { heading: 'Chunking the source', wordBudget: 200, keyPoints: ['markdown + code chunkers'], needsVisual: false },
                { heading: 'Embedding and storage', wordBudget: 250, keyPoints: ['Titan v2', 'pgvector HNSW'], needsVisual: true },
                { heading: 'Hybrid retrieval', wordBudget: 250, keyPoints: ['vector + BM25 RRF'], needsVisual: false },
            ],
            technicalFacts: ['Titan v2 produces 1024-dim embeddings', 'RRF fuses vector and BM25 rankings'],
            suggestedTitle: 'A pgvector RAG ingestion pipeline',
            suggestedTags: ['rag', 'pgvector', 'bedrock'],
            authorDirection: 'Technical deep-dive, UK English.',
        },
    },
];
