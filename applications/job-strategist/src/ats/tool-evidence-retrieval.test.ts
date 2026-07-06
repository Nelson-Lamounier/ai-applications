/** @format */
import { attachCodeEvidence, citableFiles } from './tool-evidence-retrieval.js';
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

    it('STRIPS matcher repo files from a soft skill (the résumé-data pollution)', () => {
        // The matcher lexically attached a frontend résumé-data file to a soft skill.
        // A soft skill resolves to no code canonical → repo files cleared (career-grounded).
        const r = attachCodeEvidence(
            [entry({ tool: 'Complex technical communication', evidenceFiles: ['Nelson-Lamounier/tucaken-app/src/lib/resumes/resume-data.ts'] })],
            DEPS,
        );
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

    // ── C: vendor-transferable skills cite the ALTERNATIVE's real code ──────
    const BEDROCK_DEPS = {
        canonicalToFiles: new Map<string, string[]>([['aws_bedrock', ['Nelson-Lamounier/ai-applications/src/bedrock/agent.ts']]]),
        aliasToCanonical: new Map<string, string>([['bedrock', 'aws_bedrock'], ['aws bedrock', 'aws_bedrock']]),
    };

    it('attaches the alternative\'s code files to a vendor-transferable skill (OpenAI → Bedrock)', () => {
        const r = attachCodeEvidence([entry({
            tool: 'OpenAI API', status: 'transferable', evidenceFiles: [],
            transferableBridge: 'Hands-on experience with interchangeable alternatives in the same technology family (aws bedrock).',
        })], BEDROCK_DEPS);
        expect(r[0].evidenceFiles).toEqual(['Nelson-Lamounier/ai-applications/src/bedrock/agent.ts']);
    });

    it('does NOT invent code for a transferable SOFT skill whose bridge names no code tech', () => {
        const r = attachCodeEvidence([entry({
            tool: 'problem solving', status: 'transferable', evidenceFiles: [],
            transferableBridge: 'Implied by the role\'s verified competencies — the matcher did not flag this as a gap.',
        })], BEDROCK_DEPS);
        expect(r[0].evidenceFiles).toEqual([]);
    });
});

describe('case-sensitive canonical collisions + citable files', () => {
    const reactDeps = {
        canonicalToFiles: new Map<string, string[]>([
            ['react', [
                'Nelson-Lamounier/ai-applications/applications/job-strategist/src/render/react-pdf.ts',
                'Nelson-Lamounier/ai-applications/yarn.lock',
                'Nelson-Lamounier/frontend-portfolio/apps/site/src/components/Hero.tsx',
            ]],
        ]),
        aliasToCanonical: new Map<string, string>([['react', 'react']]),
    };
    const entry = (tool: string): SkillEvidenceEntry => ({
        tool, status: 'transferable', evidenceFiles: ['some/matcher/file.md'],
        evidence: 'x', transferableBridge: '',
    } as SkillEvidenceEntry);

    it('"ReAct" (agent pattern) never resolves to the react UI-library canonical', () => {
        const [out] = attachCodeEvidence([entry('ReAct')], reactDeps);
        // No canonical resolved + transferable with empty bridge → files stripped (soft path).
        expect(out.evidenceFiles).toEqual([]);
    });

    it('"React" (the UI library, brand casing) still resolves and cites citable code only', () => {
        const [out] = attachCodeEvidence([entry('React component development')], reactDeps);
        expect(out.evidenceFiles.length).toBeGreaterThan(0);
        expect(out.evidenceFiles.join(' ')).not.toContain('yarn.lock');
    });

    it('lowercase "react.js" in a JD phrase resolves (accepted spelling)', () => {
        const [out] = attachCodeEvidence([entry('frontend work with react.js and hooks')], reactDeps);
        expect(out.evidenceFiles.length).toBeGreaterThan(0);
    });

    it('citableFiles drops lockfiles and build output, keeps source', () => {
        expect(citableFiles([
            'a/yarn.lock', 'b/package-lock.json', 'c/dist/index.js', 'd/node_modules/x.js',
            'e/src/agent.ts', 'f/go.sum', 'g/cdk.out/tree.json',
        ])).toEqual(['e/src/agent.ts']);
    });

    it('a bridge naming an accepted spelling cites files; a case-collision does not', () => {
        const bridged = (bridge: string): SkillEvidenceEntry => ({
            tool: 'SomePattern', status: 'transferable', evidenceFiles: ['x.md'],
            evidence: 'x', transferableBridge: bridge,
        } as SkillEvidenceEntry);
        const [hit] = attachCodeEvidence([bridged('interchangeable alternative (React)')], reactDeps);
        expect(hit.evidenceFiles.join(' ')).toContain('react-pdf.ts');
        const [miss] = attachCodeEvidence([bridged('approximates the ReAct cycle')], reactDeps);
        expect(miss.evidenceFiles).toEqual([]);
    });
});
