/** @format */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import { parseKbPassages, attachPassageProvenance } from './ledger-provenance.js';

const SEP = '\n\n---\n\n';
const kb = [
    '[Source: Nelson-Lamounier/ai-applications/applications/shared/src/rds/RdsSyncStateRepository.ts, Cosine: 0.612, Rerank: 0.480]\nexport class RdsSyncStateRepository { /* tracks sync state per user/repo */ }',
    '[Source: Nelson-Lamounier/ai-applications/docs/decisions/0002-pgvector-over-pinecone-for-cache.md, Cosine: 0.729, Rerank: 0.512]\npgvector for the semantic cache, Pinecone for the Knowledge Base. The split is by workload shape.',
    '[Source: Nelson-Lamounier/kubernetes-bootstrap/charts/admin-api/values.yaml, Score: 0.401]\nreplicaCount and rollout strategy configuration.',
].join(SEP);

const entry = (tool: string, status: SkillEvidenceEntry['status'] = 'verified'): SkillEvidenceEntry =>
    ({ tool, status, evidenceFiles: [], evidence: 'x', transferableBridge: '' } as SkillEvidenceEntry);

describe('parseKbPassages', () => {
    it('parses cosine+rerank headers and the legacy score header', () => {
        const p = parseKbPassages(kb, SEP);
        expect(p).toHaveLength(3);
        expect(p[0].cosine).toBeCloseTo(0.612);
        expect(p[0].rerank).toBeCloseTo(0.48);
        expect(p[2].cosine).toBeCloseTo(0.401);
        expect(p[2].rerank).toBeUndefined();
        expect(p[1].text).toContain('pgvector for the semantic cache');
    });

    it('empty context → empty list', () => {
        expect(parseKbPassages('', SEP)).toEqual([]);
    });
});

describe('attachPassageProvenance', () => {
    const passages = parseKbPassages(kb, SEP);

    it('joins compound-identifier passages onto a conceptual verified skill', () => {
        const [out] = attachPassageProvenance([entry('State management and sync')], passages);
        expect(out.provenance?.[0].source).toContain('RdsSyncStateRepository');
        expect(out.provenance?.[0].cosine).toBeCloseTo(0.612);
        expect(out.provenance?.[0].snippet.length).toBeLessThanOrEqual(200);
    });

    it('ranks by token hits then cosine', () => {
        const [out] = attachPassageProvenance([entry('pgvector semantic cache')], passages);
        expect(out.provenance?.[0].source).toContain('0002-pgvector-over-pinecone');
    });

    it('gap entries never get provenance (honesty invariant)', () => {
        const [out] = attachPassageProvenance([entry('pgvector', 'gap')], passages);
        expect(out.provenance).toBeUndefined();
    });

    it('no matching passage → entry unannotated', () => {
        const [out] = attachPassageProvenance([entry('Salesforce Apex triggers')], passages);
        expect(out.provenance).toBeUndefined();
    });

    describe('negation guard', () => {
        const supportingKb = [
            '[Source: Nelson-Lamounier/kubernetes-bootstrap/charts/api/values.yaml, Score: 0.55]\nKubernetes orchestrates the API deployment, with rolling updates and autoscaling configured across all pods.',
        ].join(SEP);
        const negatedKb = [
            '[Source: Nelson-Lamounier/cdk-monitoring/docs/architecture/migration.md, Score: 0.55]\nThe platform migrated away from Kubernetes to a fully serverless Lambda architecture last quarter.',
        ].join(SEP);
        const noLongerKb = [
            '[Source: Nelson-Lamounier/cdk-monitoring/docs/architecture/migration.md, Score: 0.55]\nThe team no longer uses Kubernetes for the ingestion pipeline; it now runs on managed Fargate tasks.',
        ].join(SEP);

        it('does NOT attach a passage saying "migrated away from Kubernetes" as support', () => {
            const [out] = attachPassageProvenance([entry('Kubernetes')], parseKbPassages(negatedKb, SEP));
            expect(out.provenance).toBeUndefined();
        });

        it('does NOT attach a passage saying "no longer use X" as support', () => {
            const [out] = attachPassageProvenance([entry('Kubernetes')], parseKbPassages(noLongerKb, SEP));
            expect(out.provenance).toBeUndefined();
        });

        it('DOES attach a genuinely-supporting passage for the same tool', () => {
            const [out] = attachPassageProvenance([entry('Kubernetes')], parseKbPassages(supportingKb, SEP));
            expect(out.provenance?.[0].source).toContain('kubernetes-bootstrap');
        });
    });

    describe('short canonicals', () => {
        const sqlKb = [
            '[Source: Nelson-Lamounier/ai-applications/applications/shared/src/rds/schema.sql, Score: 0.6]\nSQL migrations define the RDS schema, including indexes and constraints for the ledger tables.',
        ].join(SEP);

        it('a short canonical (SQL) with a matching passage DOES get provenance attached', () => {
            const [out] = attachPassageProvenance([entry('SQL')], parseKbPassages(sqlKb, SEP));
            expect(out.provenance?.[0].source).toContain('schema.sql');
        });
    });
});
