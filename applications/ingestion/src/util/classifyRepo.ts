import type { ProfileInputBundle } from '../agents/ProfileInputCollector.js';

export type RepoClassification =
    | 'project'
    | 'fork'
    | 'tutorial'
    | 'abandoned'
    | 'noise'
    | 'stale';

export function classifyRepo(bundle: ProfileInputBundle): RepoClassification {
    if (bundle.is_fork && bundle.commit_count < 5) return 'fork';
    if (bundle.commit_count < 3) return 'abandoned';
    if (/tutorial|hello-world|learning|playground|test-/i.test(bundle.repo_full_name)) {
        return 'tutorial';
    }
    const yearsSincePush = bundle.pushed_at
        ? (Date.now() - new Date(bundle.pushed_at).getTime()) / (365 * 86400 * 1000)
        : Infinity;
    if (yearsSincePush > 5) return 'stale';
    if (
        !bundle.readme &&
        bundle.commit_count < 10 &&
        Object.keys(bundle.manifests).length === 0
    ) {
        return 'noise';
    }
    return 'project';
}
