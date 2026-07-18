/** @format */
import { formatRepoFactsContext, type RepoFactRow, type RepoFactsPayload } from '../repo-facts-context.js';

const EMPTY_FACTS: RepoFactsPayload = {
    languages: [],
    frameworks: [],
    databases: [],
    infrastructure: [],
    tools: [],
    concepts: [],
};

function row(overrides: Partial<RepoFactRow> = {}): RepoFactRow {
    return {
        repoFullName: 'org/repo-a',
        role: 'backend',
        classification: 'project',
        facts: EMPTY_FACTS,
        ...overrides,
    };
}

function name(n: string) {
    return { name: n, version: null, evidenceCount: 1 };
}

describe('formatRepoFactsContext', () => {
    it('returns "" for an empty row list', () => {
        expect(formatRepoFactsContext([])).toBe('');
    });

    it('returns the header + one compact line for an eligible repo', () => {
        const result = formatRepoFactsContext([
            row({
                repoFullName: 'org/repo-a',
                role: 'backend',
                facts: { ...EMPTY_FACTS, languages: [name('typescript'), name('python')] },
            }),
        ]);
        expect(result).toContain('## Repo Fact Sheets');
        expect(result).toContain('- org/repo-a (backend): languages: typescript, python');
    });

    it('lists frameworks/databases/infrastructure/tools lanes, omitting empty lanes', () => {
        const result = formatRepoFactsContext([
            row({
                facts: {
                    ...EMPTY_FACTS,
                    languages: [name('typescript')],
                    frameworks: [name('next.js')],
                    databases: [name('postgresql')],
                    infrastructure: [name('aws eks')],
                    tools: [name('argocd')],
                },
            }),
        ]);
        expect(result).toBe(
            '## Repo Fact Sheets\n' +
            '- org/repo-a (backend): languages: typescript; frameworks: next.js; databases: postgresql; infrastructure: aws eks; tools: argocd',
        );
    });

    it('omits a lane entirely when it has no entries', () => {
        const result = formatRepoFactsContext([
            row({ facts: { ...EMPTY_FACTS, languages: [name('typescript')] } }),
        ]);
        expect(result).not.toContain('frameworks:');
        expect(result).not.toContain('databases:');
        expect(result).not.toContain('infrastructure:');
        expect(result).not.toContain('tools:');
        expect(result).not.toContain('concepts:');
    });

    it('formats concepts as name + files count, not just names', () => {
        const result = formatRepoFactsContext([
            row({
                facts: {
                    ...EMPTY_FACTS,
                    concepts: [
                        { name: 'observability', detector: 'grafana-config', files: 11 },
                        { name: 'ci/cd pipelines', detector: 'signal', files: 0 },
                    ],
                },
            }),
        ]);
        expect(result).toContain('concepts: observability (11 files), ci/cd pipelines (0 files)');
    });

    it('caps each lane at 6 entries', () => {
        const languages = Array.from({ length: 9 }, (_, i) => name(`lang-${i}`));
        const result = formatRepoFactsContext([row({ facts: { ...EMPTY_FACTS, languages } })]);
        expect(result).toContain(
            'languages: lang-0, lang-1, lang-2, lang-3, lang-4, lang-5',
        );
        expect(result).not.toContain('lang-6');
    });

    it('caps the concepts lane at 6 entries', () => {
        const concepts = Array.from({ length: 8 }, (_, i) => ({ name: `concept-${i}`, detector: 'signal', files: i }));
        const result = formatRepoFactsContext([row({ facts: { ...EMPTY_FACTS, concepts } })]);
        expect(result).toContain('concept-5');
        expect(result).not.toContain('concept-6');
    });

    it('does not leak file paths — names and counts only', () => {
        const result = formatRepoFactsContext([
            row({
                facts: {
                    ...EMPTY_FACTS,
                    concepts: [{ name: 'observability', detector: 'grafana-config', files: 3 }],
                },
            }),
        ]);
        // repoFullName itself legitimately contains a "/" (org/repo) — the guard is
        // that no FILE path (extension, nested path) ever appears in the block.
        expect(result).not.toMatch(/\.(ts|js|py|yaml|yml|json)\b/);
        expect(result).not.toContain('grafana-config');
        expect(result).not.toContain('src/');
    });

    it('excludes repos classified as "fork"', () => {
        const result = formatRepoFactsContext([
            row({ classification: 'fork', facts: { ...EMPTY_FACTS, languages: [name('typescript')] } }),
        ]);
        expect(result).toBe('');
    });

    it('excludes repos classified as "noise"', () => {
        const result = formatRepoFactsContext([
            row({ classification: 'noise', facts: { ...EMPTY_FACTS, languages: [name('typescript')] } }),
        ]);
        expect(result).toBe('');
    });

    it('includes repos with a null classification', () => {
        const result = formatRepoFactsContext([
            row({ classification: null, facts: { ...EMPTY_FACTS, languages: [name('typescript')] } }),
        ]);
        expect(result).toContain('org/repo-a');
    });

    it('includes eligible repos alongside excluded ones, header present once', () => {
        const result = formatRepoFactsContext([
            row({ repoFullName: 'org/repo-a', classification: 'fork', facts: { ...EMPTY_FACTS, languages: [name('typescript')] } }),
            row({ repoFullName: 'org/repo-b', classification: 'project', facts: { ...EMPTY_FACTS, languages: [name('python')] } }),
        ]);
        expect(result).not.toContain('org/repo-a');
        expect(result).toContain('org/repo-b');
        const headerCount = (result.match(/## Repo Fact Sheets/g) ?? []).length;
        expect(headerCount).toBe(1);
    });

    it('returns "" when every row is excluded', () => {
        const result = formatRepoFactsContext([
            row({ classification: 'fork' }),
            row({ classification: 'noise' }),
        ]);
        expect(result).toBe('');
    });

    it('renders a repo with no eligible lanes as just the header + role line', () => {
        const result = formatRepoFactsContext([row()]);
        expect(result).toBe('## Repo Fact Sheets\n- org/repo-a (backend): ');
    });
});
