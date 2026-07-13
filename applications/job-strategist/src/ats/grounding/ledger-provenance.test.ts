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
});
