/**
 * @format
 * file-classifier — assign a semantic role to a repository file
 *
 * Every ingested chunk carries `metadata.fileClass` so retrieval can filter and
 * weight by role rather than treating all text alike. Without this, a CI YAML,
 * a unit test, an IaC manifest, and application source are indistinguishable —
 * which is exactly why whole categories were previously excluded to stop them
 * polluting prose/skills queries. A role lane lets them coexist safely.
 *
 * Pure and path-only (no content, no I/O) — trivially testable. Precedence is
 * load-bearing: the first matching rule wins, ordered so that a more specific
 * role (a workflow YAML, a helm YAML, a test file) beats the generic role its
 * bare extension would otherwise imply.
 *
 * Relationship to {@link ../../projects/repo-signals} and
 * {@link ../../projects/evidence-topology} — deliberately two LEVELS, not a
 * duplication to collapse:
 *   - THIS module is CHUNK-level: one role per file, stamped on every chunk so
 *     the retriever can filter/weight an individual hit (e.g. `fileClass='iac'`).
 *   - repo-signals/evidence-topology are REPO-level summaries (46 archetype
 *     booleans + topology) consumed by the PROFILE layer for repo-wide
 *     filter/boost (e.g. "only repos with `has_ci`"). They keep richer,
 *     per-signal detection (helm vs k8s vs argocd) that a single coarse
 *     fileClass intentionally flattens.
 * The overlap is the small infra subset (ci/iac/dockerfile); the two are kept
 * separate by design so neither loses fidelity. Keep their role meanings
 * consistent when editing either.
 */

export type FileClass =
    | 'source'
    | 'test'
    | 'ci'
    | 'iac'
    | 'db'
    | 'config'
    | 'script'
    | 'docs'
    | 'data'
    | 'history'
    | 'other';

function extensionOf(filePath: string): string {
    const base = filePath.split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function baseName(filePath: string): string {
    return filePath.split('/').pop() ?? '';
}

const DOCS_EXT = new Set(['md', 'mdx']);
const SOURCE_EXT = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs',
    'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
    'cs', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'swift', 'php', 'rb',
]);
const CONFIG_EXT = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg', 'conf', 'properties']);
const SCRIPT_EXT = new Set(['sh', 'bash', 'zsh', 'ps1', 'bat']);
const DATA_EXT = new Set(['csv', 'tsv', 'ndjson', 'parquet', 'avro']);

const TEST_PATH = /(?:(?:^|\/)(?:tests?|__tests__|spec)\/)|(?:\.test\.|\.spec\.|_test\.)|(?:(?:^|\/)test_[^/]*\.py$)/i;
const CI_PATH = /(?:^|\/)\.github\/workflows\/|(?:^|\/)\.circleci\/|(?:^|\/)\.gitlab-ci\.ya?ml$|(?:^|\/)azure-pipelines\.ya?ml$/i;
const IAC_PATH = /(?:^|\/)(?:terraform|infra|cdk|charts|helm|k8s|kustomize|ansible|playbooks|roles)\/|(?:^|\/)lib\/stacks\//i;
const DB_PATH = /(?:^|\/)(?:migrations?|migrate)\//i;

const DOCKER_COMPOSE = /^docker-compose(\.[^.]+)?\.ya?ml$/i;

interface FileMeta {
    path: string;
    ext:  string;
    base: string;
}

/**
 * Ordered rules — first match wins. Each predicate stays small; precedence is
 * expressed by position so a workflow/helm YAML or a test file beats the generic
 * role its bare extension implies.
 */
const RULES: ReadonlyArray<readonly [(f: FileMeta) => boolean, FileClass]> = [
    [(f) => f.ext === 'commit_history' || f.path.startsWith('_commits/'), 'history'],
    [(f) => TEST_PATH.test(f.path), 'test'],
    [(f) => CI_PATH.test(f.path) || f.base === 'Jenkinsfile', 'ci'],
    [(f) => isIac(f), 'iac'],
    [(f) => f.ext === 'sql' || f.ext === 'prisma' || DB_PATH.test(f.path), 'db'],
    [(f) => DOCS_EXT.has(f.ext), 'docs'],
    [(f) => SCRIPT_EXT.has(f.ext) || f.base === 'Makefile', 'script'],
    [(f) => SOURCE_EXT.has(f.ext), 'source'],
    [(f) => CONFIG_EXT.has(f.ext), 'config'],
    [(f) => DATA_EXT.has(f.ext), 'data'],
];

/** Infrastructure as code — HCL, containers, CDK, helm, k8s, ansible. */
function isIac(f: FileMeta): boolean {
    return (
        f.ext === 'tf' || f.ext === 'tfvars' ||
        f.base === 'Dockerfile' || f.base.endsWith('.Dockerfile') ||
        DOCKER_COMPOSE.test(f.base) ||
        IAC_PATH.test(f.path)
    );
}

/** Assign a single semantic role to a file path. First matching rule wins. */
export function classifyFile(filePath: string): FileClass {
    const f: FileMeta = { path: filePath, ext: extensionOf(filePath), base: baseName(filePath) };
    for (const [matches, cls] of RULES) {
        if (matches(f)) return cls;
    }
    return 'other';
}
