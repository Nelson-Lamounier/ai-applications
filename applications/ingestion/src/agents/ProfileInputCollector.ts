import type { GitHubAdapter } from '@bedrock/shared';
import { PiiScrubber } from '@bedrock/shared';
import type { FileFetchCache } from '../util/FileFetchCache.js';

const piiScrubber = new PiiScrubber();
const scrub = (s: string | null | undefined): string | null | undefined =>
    s == null ? s : piiScrubber.scrub(s).redacted;

export interface ProfileInputBundle {
    repo_full_name:          string;
    primary_language:        string | null;
    description:             string | null;
    topics:                  string[];
    stars:                   number;
    forks:                   number;
    is_fork:                 boolean;
    created_at:              string | null;
    pushed_at:               string | null;
    commit_count:            number;
    readme:                  string | null;
    manifests:               Record<string, string>;
    changelog:               string | null;
    workflows:               Record<string, string>;
    recent_commit_messages:  string[];
}

const README_CANDIDATES     = ['README.md', 'README', 'Readme.md'];
const MANIFEST_FILES        = ['package.json', 'requirements.txt', 'Cargo.toml',
                               'go.mod', 'pyproject.toml', 'pom.xml', 'Gemfile'];
const CHANGELOG_CANDIDATES  = ['CHANGELOG.md', 'CHANGELOG', 'HISTORY.md'];
const MAX_WORKFLOWS         = 5;
const MAX_COMMITS           = 30;

export class ProfileInputCollector {
    constructor(
        private readonly adapter: GitHubAdapter,
        private readonly cache:   FileFetchCache,
    ) {}

    async collect(repoFullName: string): Promise<ProfileInputBundle> {
        const [meta, commits, readme, manifests, changelog, workflows] = await Promise.all([
            this.adapter.getRepoMeta(repoFullName),
            this.adapter.listCommits(repoFullName, { maxCommits: MAX_COMMITS }),
            this.fetchFirstMatch(repoFullName, README_CANDIDATES),
            this.fetchManifests(repoFullName),
            this.fetchFirstMatch(repoFullName, CHANGELOG_CANDIDATES),
            this.fetchWorkflows(repoFullName),
        ]);

        const scrubbedManifests: Record<string, string> = {};
        for (const [k, v] of Object.entries(manifests)) {
            scrubbedManifests[k] = piiScrubber.scrub(v).redacted;
        }
        const scrubbedWorkflows: Record<string, string> = {};
        for (const [k, v] of Object.entries(workflows)) {
            scrubbedWorkflows[k] = piiScrubber.scrub(v).redacted;
        }

        return {
            repo_full_name:         repoFullName,
            primary_language:       meta.primary_language,
            description:            scrub(meta.description) ?? null,
            topics:                 meta.topics,
            stars:                  meta.stars,
            forks:                  meta.forks,
            is_fork:                meta.is_fork,
            created_at:             meta.created_at,
            pushed_at:              meta.pushed_at,
            commit_count:           commits.length,
            readme:                 scrub(readme) ?? null,
            manifests:              scrubbedManifests,
            changelog:              scrub(changelog) ?? null,
            workflows:              scrubbedWorkflows,
            recent_commit_messages: commits.map(c => piiScrubber.scrub(c.message).redacted),
        };
    }

    private async fetchFile(repoFullName: string, filePath: string): Promise<string | null> {
        const cached = this.cache.get(filePath);
        if (cached.hit) return cached.value ?? null;

        try {
            const content = await this.adapter.fetchFile(repoFullName, filePath);
            this.cache.set(filePath, content);
            return content;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('returned 404')) {
                this.cache.set(filePath, null);
                return null;
            }
            console.warn(`[ProfileInputCollector] fetchFile ${filePath} warn:`, msg);
            return null;
        }
    }

    private async fetchFirstMatch(
        repoFullName: string,
        candidates: string[],
    ): Promise<string | null> {
        for (const path of candidates) {
            const content = await this.fetchFile(repoFullName, path);
            if (content !== null) return content;
        }
        return null;
    }

    private async fetchManifests(repoFullName: string): Promise<Record<string, string>> {
        const results = await Promise.all(
            MANIFEST_FILES.map(async f => ({ file: f, content: await this.fetchFile(repoFullName, f) })),
        );
        const out: Record<string, string> = {};
        for (const { file, content } of results) {
            if (content !== null) out[file] = content;
        }
        return out;
    }

    private async fetchWorkflows(repoFullName: string): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        try {
            const files = await this.adapter.listFiles(repoFullName);
            const workflows = files
                .filter(f => f.path.startsWith('.github/workflows/') &&
                             (f.path.endsWith('.yml') || f.path.endsWith('.yaml')))
                .slice(0, MAX_WORKFLOWS);

            const results = await Promise.all(
                workflows.map(async f => ({
                    path: f.path,
                    content: await this.fetchFile(repoFullName, f.path),
                })),
            );
            for (const { path, content } of results) {
                if (content !== null) out[path] = content;
            }
        } catch (err) {
            console.warn('[ProfileInputCollector] fetchWorkflows warn:', err);
        }
        return out;
    }
}
