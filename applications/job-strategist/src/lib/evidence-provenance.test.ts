/** @format */
import { buildProvenanceRows, buildRepoQualityRows } from './evidence-provenance.js';

const KB = [
    '[Source: Nelson-Lamounier/cdk-monitoring/docs/k8s.md, Cosine: 0.390, Rerank: 0.810]',
    'Self-hosted Kubernetes via kubeadm…',
    '[Source: Nelson-Lamounier/ai-applications/docs/checklists/structure-output-checklist.md, Cosine: 0.300, Rerank: 0.700]',
    'OpenAI example…',
    '[Source: Nelson-Lamounier/ai-applications/applications/shared/src/metrics.ts, Cosine: 0.150, Rerank: 0.200]',
    'metrics code…',
    '[Source: Nelson-Lamounier/ai-applications/docs/unused.md, Cosine: 0.250, Rerank: 0.260]',
    'never cited…',
].join('\n');

const inputs = {
    kbContext: KB,
    floor: 0.2,
    verifiedFiles: new Set(['Nelson-Lamounier/ai-applications/applications/shared/src/metrics.ts']),
    partialFiles: new Set<string>(),
    demotedFiles: new Map<string, 'vendor_provenance' | 'code_truth'>([
        ['Nelson-Lamounier/cdk-monitoring/docs/k8s.md', 'code_truth'],
        ['Nelson-Lamounier/ai-applications/docs/checklists/structure-output-checklist.md', 'vendor_provenance'],
    ]),
};

describe('buildProvenanceRows', () => {
    it('emits one row per retrieved passage with repo + scores', () => {
        const rows = buildProvenanceRows(inputs);
        expect(rows).toHaveLength(4);
        const k8s = rows.find((r) => r.filePath.endsWith('k8s.md'));
        expect(k8s).toMatchObject({ repoFullName: 'Nelson-Lamounier/cdk-monitoring', cosine: 0.39, rerank: 0.81, passedFloor: true });
    });

    it('attributes usage: demoted > verified > retrieved, with reason', () => {
        const rows = buildProvenanceRows(inputs);
        const byFile = (suffix: string) => rows.find((r) => r.filePath.endsWith(suffix));
        expect(byFile('k8s.md')).toMatchObject({ usageStatus: 'demoted', demotionReason: 'code_truth' });
        expect(byFile('structure-output-checklist.md')).toMatchObject({ usageStatus: 'demoted', demotionReason: 'vendor_provenance' });
        expect(byFile('metrics.ts')).toMatchObject({ usageStatus: 'cited_verified', demotionReason: null });
        expect(byFile('unused.md')).toMatchObject({ usageStatus: 'retrieved', demotionReason: null });
    });

    it('marks passed_floor from the cosine floor', () => {
        const rows = buildProvenanceRows(inputs);
        expect(rows.find((r) => r.filePath.endsWith('metrics.ts'))?.passedFloor).toBe(false); // 0.15 < 0.2
        expect(rows.find((r) => r.filePath.endsWith('unused.md'))?.passedFloor).toBe(true);   // 0.25 >= 0.2
    });

    it('cited_partial when the file is only in partial matches', () => {
        const rows = buildProvenanceRows({
            ...inputs,
            verifiedFiles: new Set(),
            partialFiles: new Set(['Nelson-Lamounier/ai-applications/applications/shared/src/metrics.ts']),
            demotedFiles: new Map(),
        });
        expect(rows.find((r) => r.filePath.endsWith('metrics.ts'))?.usageStatus).toBe('cited_partial');
    });

    it('parses the legacy Score header (rerank = cosine)', () => {
        const rows = buildProvenanceRows({ ...inputs, kbContext: '[Source: o/r/a.md, Score: 0.42]\ntext', demotedFiles: new Map(), verifiedFiles: new Set(), partialFiles: new Set() });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ cosine: 0.42, rerank: 0.42, usageStatus: 'retrieved' });
    });

    it('returns no rows for an empty kbContext', () => {
        expect(buildProvenanceRows({ ...inputs, kbContext: '' })).toHaveLength(0);
    });
});

describe('buildRepoQualityRows', () => {
    const rows = buildProvenanceRows(inputs); // cdk: 1 demoted; ai-applications: 1 demoted, 1 verified, 1 retrieved
    const codeTech = new Map<string, Set<string>>([
        ['Nelson-Lamounier/cdk-monitoring', new Set(['aws_eks', 'kubernetes', 'argocd'])],
        ['Nelson-Lamounier/ai-applications', new Set(['typescript'])],
    ]);

    it('aggregates per repo: retrieved/cited/demoted + cite_rate + code richness', () => {
        const q = buildRepoQualityRows(rows, codeTech);
        const ai = q.find((r) => r.repoFullName === 'Nelson-Lamounier/ai-applications');
        // ai-applications passages: checklist (demoted), metrics.ts (cited_verified), unused.md (retrieved)
        expect(ai).toMatchObject({ passagesRetrieved: 3, passagesCited: 1, demotedCount: 1, codeTechCount: 1 });
        expect(ai?.citeRate).toBeCloseTo(1 / 3, 2);
        const cdk = q.find((r) => r.repoFullName === 'Nelson-Lamounier/cdk-monitoring');
        expect(cdk).toMatchObject({ passagesRetrieved: 1, passagesCited: 0, demotedCount: 1, codeTechCount: 3 });
    });

    it('codeTechCount is 0 for a repo with no extracted code', () => {
        const q = buildRepoQualityRows(rows, new Map());
        expect(q.every((r) => r.codeTechCount === 0)).toBe(true);
    });

    it('returns no rows for an empty trace', () => {
        expect(buildRepoQualityRows([], codeTech)).toHaveLength(0);
    });
});
