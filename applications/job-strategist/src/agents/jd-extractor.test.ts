/** @format */
import { jdRetrievalQueries, formatJdExtraction, JdExtractionSchema, type JdExtraction } from './jd-extractor.js';

const JD: JdExtraction = {
    requiredSkills:    ['Kubernetes', 'IAM'],
    preferredSkills:   ['ArgoCD'],
    tools:             ['AWS', 'Terraform'],
    concepts:          ['incident response'],
    responsibilities:  ['operate production infra'],
    domain:            'Cloud/DevOps',
    seniority:         'senior',
    retrievalKeywords: ['kubernetes', 'iam', 'terraform'],
};

describe('jdRetrievalQueries', () => {
    it('builds a skill query from skills + tools + keywords, deduped', () => {
        const q = jdRetrievalQueries(JD);
        expect(q.skill).toContain('Kubernetes');
        expect(q.skill).toContain('Terraform');
        // 'kubernetes' (keyword) and 'Kubernetes' (skill) are distinct tokens; dedupe is exact-string.
        expect(q.skill.split(' ').filter((t) => t === 'AWS')).toHaveLength(1);
    });
    it('builds experience + project queries with their anchor phrases', () => {
        const q = jdRetrievalQueries(JD);
        expect(q.experience).toContain('professional experience');
        expect(q.experience).toContain('operate production infra');
        expect(q.project).toContain('portfolio project');
        expect(q.project).toContain('Terraform');
    });
    it('handles empty extraction without crashing', () => {
        const empty = JdExtractionSchema.parse({});
        const q = jdRetrievalQueries(empty);
        expect(q.skill).toBe('');
        expect(q.experience).toContain('professional experience');
    });
});

describe('formatJdExtraction', () => {
    it('renders domain, seniority, and the skill/tool lists', () => {
        const out = formatJdExtraction(JD);
        expect(out).toContain('EXTRACTED JD SIGNAL');
        expect(out).toContain('Domain: Cloud/DevOps');
        expect(out).toContain('Required skills: Kubernetes, IAM');
        expect(out).toContain('Tools: AWS, Terraform');
    });
    it('omits empty lines', () => {
        const out = formatJdExtraction(JdExtractionSchema.parse({ requiredSkills: ['Go'] }));
        expect(out).toContain('Required skills: Go');
        expect(out).not.toContain('Preferred skills');
        expect(out).not.toContain('Domain:');
    });
});

describe('JdExtractionSchema', () => {
    it('defaults all fields so a partial model payload is safe', () => {
        const parsed = JdExtractionSchema.parse({ requiredSkills: ['Rust'] });
        expect(parsed).toEqual({
            requiredSkills: ['Rust'], preferredSkills: [], tools: [], concepts: [],
            responsibilities: [], domain: '', seniority: '', retrievalKeywords: [],
        });
    });
});
