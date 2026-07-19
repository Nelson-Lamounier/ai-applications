/** @format */
import { buildDecisionEvidenceContext } from '../decision-evidence-context.js';

const JD = { targetRole: 'Staff Backend Engineer', concepts: ['distributed systems', 'scalability', 'caching'] };

describe('buildDecisionEvidenceContext', () => {
    afterEach(() => {
        delete process.env['DOCTYPE_EVIDENCE_K'];
    });

    it('returns "" when retrieve resolves with no items', async () => {
        const retrieve = jest.fn().mockResolvedValue([]);
        const result = await buildDecisionEvidenceContext(retrieve, JD, ['adr'], 'architecture');
        expect(result).toBe('');
    });

    it('returns "" and never throws when retrieve rejects (fail-open)', async () => {
        const retrieve = jest.fn().mockRejectedValue(new Error('rds down'));
        const result = await buildDecisionEvidenceContext(retrieve, JD, ['adr'], 'architecture');
        expect(result).toBe('');
    });

    it('builds the header + architecture intent sentence + bullet items', async () => {
        const retrieve = jest.fn().mockResolvedValue(['[Source: org/repo, Cosine: 0.500, Rerank: 0.400]\nADR-001: chose event sourcing.']);
        const result = await buildDecisionEvidenceContext(retrieve, JD, ['adr'], 'architecture');
        expect(result).toContain('## Design & Operational Evidence');
        expect(result).toContain("Architecture-decision records (ADRs) evidencing the candidate's design reasoning:");
        expect(result).toContain('- [Source: org/repo, Cosine: 0.500, Rerank: 0.400] ADR-001: chose event sourcing.');
    });

    it('builds the operations intent sentence', async () => {
        const retrieve = jest.fn().mockResolvedValue(['[Source: org/repo, Cosine: 0.500, Rerank: 0.400]\nRunbook: rotate the DB credentials.']);
        const result = await buildDecisionEvidenceContext(retrieve, JD, ['runbook', 'troubleshooting'], 'operations');
        expect(result).toContain('Runbooks and troubleshooting guides evidencing operational ownership:');
    });

    it('builds a combined sentence for angle "both"', async () => {
        const retrieve = jest.fn().mockResolvedValue(['[Source: org/repo, Cosine: 0.500, Rerank: 0.400]\nADR-002.']);
        const result = await buildDecisionEvidenceContext(retrieve, JD, ['adr', 'runbook', 'troubleshooting'], 'both');
        expect(result).toContain('Architecture-decision records');
        expect(result).toContain('runbooks and troubleshooting guides');
    });

    it('calls retrieve with a compact query built from targetRole + first 6 concepts, and default K=6', async () => {
        const manyConcepts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const retrieve = jest.fn().mockResolvedValue([]);
        await buildDecisionEvidenceContext(retrieve, { ...JD, concepts: manyConcepts }, ['adr'], 'architecture');

        expect(retrieve).toHaveBeenCalledTimes(1);
        const [query, k] = retrieve.mock.calls[0]!;
        expect(query).toBe('Staff Backend Engineer — a, b, c, d, e, f');
        expect(k).toBe(6);
    });

    it('honours DOCTYPE_EVIDENCE_K env override', async () => {
        process.env['DOCTYPE_EVIDENCE_K'] = '3';
        const retrieve = jest.fn().mockResolvedValue([]);
        await buildDecisionEvidenceContext(retrieve, JD, ['adr'], 'architecture');
        const [, k] = retrieve.mock.calls[0]!;
        expect(k).toBe(3);
    });

    it('caps rendered items defensively to K even if retrieve over-returns', async () => {
        process.env['DOCTYPE_EVIDENCE_K'] = '2';
        const items = [1, 2, 3, 4].map((i) => `[Source: org/repo, Cosine: 0.500, Rerank: 0.400]\nitem-${i}`);
        const retrieve = jest.fn().mockResolvedValue(items);
        const result = await buildDecisionEvidenceContext(retrieve, JD, ['adr'], 'architecture');
        expect(result).toContain('item-1');
        expect(result).toContain('item-2');
        expect(result).not.toContain('item-3');
        expect(result).not.toContain('item-4');
    });

    it('renders only the source annotation and trimmed text — no new untrusted fields', async () => {
        const retrieve = jest.fn().mockResolvedValue(['[Source: org/repo, Cosine: 0.500, Rerank: 0.400]\nplain evidence text']);
        const result = await buildDecisionEvidenceContext(retrieve, JD, ['adr'], 'architecture');
        expect(result).toBe(
            '## Design & Operational Evidence\n' +
            "Architecture-decision records (ADRs) evidencing the candidate's design reasoning:\n\n" +
            '- [Source: org/repo, Cosine: 0.500, Rerank: 0.400] plain evidence text',
        );
    });
});
