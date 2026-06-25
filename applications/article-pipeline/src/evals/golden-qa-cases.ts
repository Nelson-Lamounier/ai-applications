/**
 * @format
 * Golden QA cases for the QA-phase live eval. Each carries a single planted
 * defect in a known dimension (or none, for the clean control). Typed against
 * WriterResult so the QA agent receives exactly the shape it gets in production.
 */
import type { ArticleMetadata, WriterResult } from '@bedrock/shared';
import type { QaGoldenCase } from './qa-eval-score.js';

const baseMeta = (over: Partial<ArticleMetadata> = {}): ArticleMetadata => ({
    title:               'Bootstrapping EKS with ArgoCD',
    description:         'A practical first-person walkthrough of bootstrapping an EKS cluster with ArgoCD and Helm using GitOps.',
    tags:                ['kubernetes', 'argocd', 'gitops'],
    slug:                'bootstrapping-eks-with-argocd',
    publishDate:         '2026-06-25',
    readingTime:         5,
    category:            'devops',
    aiSummary:           'How I bootstrapped EKS with ArgoCD and kept it in sync via GitOps.',
    technicalConfidence: 85,
    skillsDemonstrated:  ['kubernetes', 'gitops'],
    processingNote:      '',
    ...over,
});

const CLEAN_BODY = `---
title: Bootstrapping EKS with ArgoCD
---

# Bootstrapping EKS with ArgoCD

I run a pull-based delivery model: ArgoCD reconciles desired state from Git, so
the cluster converges on what is committed rather than what was last pushed.

## Bootstrapping the cluster

An app-of-apps root Application installs the rest. Helm charts package each
workload, and ArgoCD keeps them in sync with self-heal enabled.

## Keeping it in sync

Drift is corrected automatically; a manual change is reverted on the next
reconcile loop.
`;

export interface GoldenQaCase extends QaGoldenCase {
    readonly writer: WriterResult;
    readonly technicalFacts: string[];
}

const FACTS = [
    'ArgoCD reconciles desired state from Git',
    'Helm charts package the workloads',
    'self-heal reverts manual drift on the next reconcile',
];

export const GOLDEN_QA_CASES: ReadonlyArray<GoldenQaCase> = [
    {
        id: 'clean-control',
        expectedFlag: 'none',
        technicalFacts: FACTS,
        writer: { content: CLEAN_BODY, metadata: baseMeta(), shotList: [] },
    },
    {
        id: 'technical-defect',
        expectedFlag: 'technicalAccuracy',
        technicalFacts: FACTS,
        // Planted: directly contradicts the facts — ArgoCD is push-based, drift is ignored.
        writer: {
            content: CLEAN_BODY.replace(
                'ArgoCD reconciles desired state from Git, so\nthe cluster converges on what is committed rather than what was last pushed.',
                'ArgoCD pushes images directly to nodes over SSH and does not use Git at all, so drift is simply ignored and never reconciled.',
            ),
            metadata: baseMeta(),
            shotList: [],
        },
    },
    {
        id: 'metadata-defect',
        expectedFlag: 'metadataQuality',
        technicalFacts: FACTS,
        // Planted: absurd reading time + empty tags for a multi-paragraph article.
        writer: { content: CLEAN_BODY, metadata: baseMeta({ readingTime: 99, tags: [] }), shotList: [] },
    },
    {
        id: 'mdx-defect',
        expectedFlag: 'mdxStructure',
        technicalFacts: FACTS,
        // Planted: unterminated code fence + broken Mermaid block.
        writer: {
            content: CLEAN_BODY + '\n```mermaid\ngraph TD; A--> \n\nUnterminated code fence below:\n```ts\nconst x =',
            metadata: baseMeta(),
            shotList: [],
        },
    },
];
