/**
 * @format
 * Kind-scoped operations-angle evidence gathering -- the retrieval-only
 * bridge from an activated `OperationsTheme` set to VerifiedMatch facts the
 * projects pool can compose from. See docs/superpowers/specs/2026-07-16-
 * projects-operations-evidence-design.md Component 2.
 *
 * NO new LLM call: one deterministic retrieval per (active project, active
 * theme) pair that has >= 1 member repo whose `project_components.kind`
 * (threaded onto `ProjectAgentMeta.repoKinds`) is one of the theme's target
 * kinds, then a deterministic post-filter/rank/cap. Kept chunks become
 * `VerifiedMatch` facts (`skill: theme.label`) that flow into the EXACT SAME
 * `buildProjectPool` repo-id attribution, fail-closed cross-project isolation,
 * and `[p{i}.r{k}]` id stamping as every other verified match -- a fact whose
 * file resolves outside the project it was gathered for attributes nowhere,
 * unchanged (this module's own qualifying-repo filter is a first, redundant
 * gate; `buildProjectPool`'s repository-id attribution is the load-bearing
 * one).
 *
 * Fail-open at the per-(project, theme) retrieval call: a `retrieve()`
 * rejection yields zero facts for that pair only -- it must never abort the
 * other pairs or throw out of `gatherOperationsEvidence` itself. The caller
 * (run-pipeline.ts) additionally wraps the whole gather in its own
 * try/catch, and skips calling this module entirely when zero themes
 * activated (defended here too, as a zero-themes call is a pure no-op with
 * zero retrieval calls).
 */
import { repoOfFile } from '../../ats/grounding/evidence-lane.js';
import type { OperationsTheme } from './operations-themes.js';
import type { ProjectAgentMeta, VerifiedMatch } from './project-agent-inputs.js';

/** One retrieved chunk -- file path (repo-scoped, `owner/repo/path/...`) plus
 *  its raw (possibly markdown) text. The caller adapts its retrieval client
 *  (e.g. `querySingleRds`'s `[Source: ...]`-annotated strings) into this
 *  shape; this module has no RDS/embedding knowledge. */
export interface RetrievedPassage {
    readonly file: string;
    readonly text: string;
}

export interface OperationsEvidenceArgs {
    readonly themes: readonly OperationsTheme[];
    /** Projects with per-repo component kind threaded in (`ProjectAgentMeta.repoKinds`). */
    readonly projects: readonly ProjectAgentMeta[];
    readonly retrieve: (query: string, k: number) => Promise<ReadonlyArray<RetrievedPassage>>;
}

export interface OperationsEvidenceResult {
    readonly matches: VerifiedMatch[];
    /** Theme key -> fact count, across every project. */
    readonly factCounts: Record<string, number>;
    /** Repo full name -> fact count, across every theme. */
    readonly byRepo: Record<string, number>;
}

const RETRIEVE_K = 8;
const MAX_PER_PAIR = 2;
const MAX_PER_PROJECT = 6;
const MAX_SNIPPET_CHARS = 200;

const DOCS_PATH_RE = /(^|\/)docs\//i;
const MD_EXT_RE = /\.mdx?$/i;

/** Docs-lane preference: hand-written documentation (.md/.mdx, or a /docs/
 *  path segment) states operational intent more directly than arbitrary
 *  source, so it is preferred when both are candidates for the same slot. */
function isDocsPath(file: string): boolean {
    return MD_EXT_RE.test(file) || DOCS_PATH_RE.test(file);
}

/**
 * Deterministic, markdown-stripped, single-line snippet (<= 200 chars) --
 * the citable `sourceCitation` text. No LLM: fenced/inline code, images,
 * links, headings, and emphasis punctuation are stripped before whitespace
 * collapse and truncation.
 */
export function cleanSnippet(text: string): string {
    const stripped = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[*_>#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.length > MAX_SNIPPET_CHARS ? stripped.slice(0, MAX_SNIPPET_CHARS).trim() : stripped;
}

/** The project's member repos whose component kind is one of the theme's
 *  target kinds -- both the post-filter allowlist AND the "does this pair
 *  even need a retrieval call" gate (empty => the pair is skipped). */
function qualifyingRepos(project: ProjectAgentMeta, theme: OperationsTheme): ReadonlySet<string> {
    return new Set(
        project.repoFullNames.filter((name) => theme.kinds.includes(project.repoKinds.get(name) ?? '')),
    );
}

/**
 * One (project, theme) pair: one retrieve() call, fail-open on rejection;
 * keep only chunks whose file resolves (via `repoOfFile`) to a qualifying
 * repo and whose cleaned snippet is non-empty; prefer docs-lane chunks; cap
 * at MAX_PER_PAIR.
 */
async function gatherPair(
    theme: OperationsTheme,
    repos: ReadonlySet<string>,
    retrieve: OperationsEvidenceArgs['retrieve'],
): Promise<VerifiedMatch[]> {
    let passages: ReadonlyArray<RetrievedPassage>;
    try {
        passages = await retrieve(theme.queryTerms, RETRIEVE_K);
    } catch {
        return [];
    }

    const inScope = passages.filter((p) => {
        const repo = repoOfFile(p.file);
        return repo !== null && repos.has(repo);
    });
    const docsFirst = [...inScope].sort((a, b) => Number(isDocsPath(b.file)) - Number(isDocsPath(a.file)));

    const kept: VerifiedMatch[] = [];
    for (const passage of docsFirst) {
        if (kept.length >= MAX_PER_PAIR) break;
        const sourceCitation = cleanSnippet(passage.text);
        if (sourceCitation.length === 0) continue;
        kept.push({ skill: theme.label, sourceCitation, evidenceFiles: [passage.file] });
    }
    return kept;
}

/** One project's kept facts across every activated theme, in theme order
 *  (already JD-hit-ranked by `activateThemes`), capped at MAX_PER_PROJECT. */
async function gatherForProject(
    project: ProjectAgentMeta,
    themes: readonly OperationsTheme[],
    retrieve: OperationsEvidenceArgs['retrieve'],
): Promise<VerifiedMatch[]> {
    const kept: VerifiedMatch[] = [];
    for (const theme of themes) {
        if (kept.length >= MAX_PER_PROJECT) break;
        const repos = qualifyingRepos(project, theme);
        if (repos.size === 0) continue;
        const pairMatches = await gatherPair(theme, repos, retrieve);
        for (const m of pairMatches) {
            if (kept.length >= MAX_PER_PROJECT) break;
            kept.push(m);
        }
    }
    return kept;
}

/**
 * Gather kind-scoped operations evidence for every (active project, active
 * theme) pair. Zero themes => zero retrieval calls, empty result (defensive
 * no-op; the caller is expected to skip calling this entirely in that case).
 */
export async function gatherOperationsEvidence(args: OperationsEvidenceArgs): Promise<OperationsEvidenceResult> {
    const matches: VerifiedMatch[] = [];
    const factCounts: Record<string, number> = {};
    const byRepo: Record<string, number> = {};
    if (args.themes.length === 0) return { matches, factCounts, byRepo };

    const keyByLabel = new Map(args.themes.map((t) => [t.label, t.key]));

    for (const project of args.projects) {
        const projectMatches = await gatherForProject(project, args.themes, args.retrieve);
        for (const m of projectMatches) {
            matches.push(m);
            const themeKey = keyByLabel.get(m.skill) ?? m.skill;
            factCounts[themeKey] = (factCounts[themeKey] ?? 0) + 1;
            const repo = repoOfFile(m.evidenceFiles[0] ?? '');
            if (repo) byRepo[repo] = (byRepo[repo] ?? 0) + 1;
        }
    }
    return { matches, factCounts, byRepo };
}
