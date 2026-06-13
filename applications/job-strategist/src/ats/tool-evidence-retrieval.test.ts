/** @format */
import { attachCodeEvidence } from './tool-evidence-retrieval.js';
import type { SkillEvidenceEntry } from '@bedrock/shared';

// canonical → real code files (the structured proof lane).
const CODE_FILES = new Map<string, string[]>([
    ['python', ['Nelson-Lamounier/ai-applications/applications/ingestion/src/main.py',
                'Nelson-Lamounier/ai-applications/scripts/deploy.py']],
    ['aws_lambda', ['Nelson-Lamounier/cdk-monitoring/infra/lib/lambda-stack.ts']],
]);
const ALIAS = new Map<string, string>([
    ['python', 'python'],
    ['aws lambda', 'aws_lambda'],
    ['lambda', 'aws_lambda'],
]);
const DEPS = { canonicalToFiles: CODE_FILES, aliasToCanonical: ALIAS };

const entry = (over: Partial<SkillEvidenceEntry>): SkillEvidenceEntry =>
    ({ tool: 'X', status: 'verified', evidenceFiles: [], evidence: 'cited', ...over } as SkillEvidenceEntry);

describe('attachCodeEvidence', () => {
    it('REPLACES matcher files with real code files for a tech skill (structured-only)', () => {
        const r = attachCodeEvidence([entry({ tool: 'Python', evidenceFiles: ['some/matcher/file.md'] })], DEPS);
        expect(r[0].evidenceFiles).toEqual([
            'Nelson-Lamounier/ai-applications/applications/ingestion/src/main.py',
            'Nelson-Lamounier/ai-applications/scripts/deploy.py',
        ]);
        // the matcher's doc file is dropped — proof cites code, not docs.
        expect(r[0].evidenceFiles).not.toContain('some/matcher/file.md');
    });

    it('resolves a tech canonical from a PHRASE skill ("Python scripting and automation")', () => {
        const r = attachCodeEvidence([entry({ tool: 'Python scripting and automation', evidenceFiles: ['x'] })], DEPS);
        expect(r[0].evidenceFiles[0]).toMatch(/\.py$/);
    });

    it('does NOT attach code to a soft/experience skill (the AWS→frontend bug)', () => {
        // No code canonical is named → stays exactly as the matcher grounded it ([]).
        const r = attachCodeEvidence([entry({ tool: 'Complex technical communication and problem-solving', evidenceFiles: [] })], DEPS);
        expect(r[0].evidenceFiles).toEqual([]);
    });

    it('does NOT enrich a tech skill grounded purely in experience (no matcher files)', () => {
        // BOTH conditions required: resolves to a canonical AND not experience-grounded.
        const r = attachCodeEvidence([entry({ tool: 'Python', evidenceFiles: [] })], DEPS);
        expect(r[0].evidenceFiles).toEqual([]);
    });

    it('never touches a gap entry (honesty invariant)', () => {
        const r = attachCodeEvidence([entry({ tool: 'Python', status: 'gap', evidenceFiles: [] })], DEPS);
        expect(r[0].evidenceFiles).toEqual([]);
    });

    it('keeps the matcher files when the resolved canonical has no code evidence', () => {
        const deps = { canonicalToFiles: new Map<string, string[]>([['python', []]]), aliasToCanonical: ALIAS };
        const r = attachCodeEvidence([entry({ tool: 'Python', evidenceFiles: ['keep/me.md'] })], deps);
        expect(r[0].evidenceFiles).toEqual(['keep/me.md']);
    });

    it('never attaches a .md doc — only structured code files', () => {
        const r = attachCodeEvidence([entry({ tool: 'AWS Lambda', evidenceFiles: ['docs/readme.md'] })], DEPS);
        expect(r[0].evidenceFiles[0]).toMatch(/lambda-stack\.ts$/);
        expect(r[0].evidenceFiles.filter((f) => f.endsWith('.md'))).toHaveLength(0);
    });
});
