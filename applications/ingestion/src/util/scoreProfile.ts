import type { ExtractedRepoData } from '../agents/ProfileExtractor.js';
import type { ProfileInputBundle } from '../agents/ProfileInputCollector.js';

export interface ScoreBreakdown {
    has_readme:    number;
    has_manifest:  number;
    has_ci:        number;
    has_changelog: number;
    has_tests:     number;
    commit_count:  number;
    confidence:    number;
}

export function scoreProfile(
    extracted: ExtractedRepoData,
    _bundle: ProfileInputBundle,
): { score: number; breakdown: ScoreBreakdown } {
    const s: ExtractedRepoData['signals'] = extracted.signals;
    const breakdown: ScoreBreakdown = {
        has_readme:    s.has_readme    ? 0.25 : 0,
        has_manifest:  s.has_manifest  ? 0.20 : 0,
        has_ci:        s.has_ci        ? 0.15 : 0,
        has_changelog: s.has_changelog ? 0.10 : 0,
        has_tests:     s.has_tests     ? 0.10 : 0,
        commit_count:  s.commit_count >= 20 ? 0.10 : 0,
        confidence:    extracted.confidence >= 0.7 ? 0.10 : 0,
    };
    const score = Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0) * 1e10) / 1e10;
    return { score, breakdown };
}
