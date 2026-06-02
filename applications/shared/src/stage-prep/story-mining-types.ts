/** @format */

/** A mined interview-story candidate, emitted only when TWO corroborating artifacts exist. */
export interface StoryCandidate {
  /** 'incident' (git revert) | 'optimization' (merged PR with issue close + metric). */
  readonly storyType: 'incident' | 'optimization';
  /** Dedup key — revert sha (incident) or 'pr-'+number (optimization). */
  readonly anchorKey: string;
  /** The two corroborating artifacts (shape varies by story type). */
  readonly anchors: Record<string, unknown>;
  /** Detector confidence (incident 0.85, optimization 0.70). */
  readonly confidence: number;
}
