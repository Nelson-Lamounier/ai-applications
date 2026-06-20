/** @format */
import type {
    ProfileAggInput,
    UserProfileRollupResult,
} from '../profile/computeUserProfileRollup.js';

export interface MirrorJson { readonly paragraph: string }
export interface RevealJson { readonly reveals: ReadonlyArray<{ insight: string; evidence: string }> }
export interface ArchetypeFit  { readonly archetype: string; readonly fit: string; readonly rationale: string }
export interface SeniorityCall { readonly area: string; readonly level: string; readonly evidence: string }
export interface DirectionJson {
  readonly archetypes: ReadonlyArray<ArchetypeFit>;
  readonly seniority:  ReadonlyArray<SeniorityCall>;
  readonly whatToDeepen: ReadonlyArray<string>;
}
export interface UnsupportedClaim  { readonly claim: string; readonly resumeRef: string; readonly whyUnsupported: string }
export interface UndersoldStrength { readonly evidence: string; readonly rollupDimension: string; readonly suggestion: string }
export interface ReconciliationJson {
  readonly unsupportedClaims: ReadonlyArray<UnsupportedClaim>;
  readonly undersold:         ReadonlyArray<UndersoldStrength>;
}
export interface DiagnosticJson {
  readonly overall:    number;
  readonly components: Readonly<Record<string, { readonly score: number; readonly blockers: ReadonlyArray<string> }>>;
  readonly methodology: {
    readonly version: number;
    readonly weights: Readonly<Record<string, number>>;
    readonly notes:   string;
  };
  readonly explanation: string | null;
}
export interface RollupRow {
  readonly rollup: unknown;
  readonly mirror: MirrorJson | null;
  readonly reveal: RevealJson | null;
  readonly direction: DirectionJson | null;
  readonly reconciliation: ReconciliationJson | null;
  readonly diagnostic: DiagnosticJson | null;
  readonly refreshedAt: string;
  readonly synthesisRefreshedAt: string | null;
}

export interface IUserProfileRollupRepository {
    /** ALL of the user's repository_profiles rows (pure fn applies scope). */
    listProfilesForRollup(userId: string): Promise<ProfileAggInput[]>;
    /** Upsert the precomputed rollup for the user (one row per user). */
    upsert(userId: string, result: UserProfileRollupResult,
           mirror?: MirrorJson, reveal?: RevealJson, direction?: DirectionJson,
           reconciliation?: ReconciliationJson, diagnostic?: DiagnosticJson,
           synthesisInputHash?: string | null): Promise<void>;
    /** Read the persisted rollup row for the user, or null if absent. */
    getRollup(userId: string): Promise<RollupRow | null>;
    /** Synthesis-skip state: stored aggregate-rollup hash + whether synthesis exists. */
    getSynthesisState?(userId: string): Promise<{ inputHash: string | null; hasSynthesis: boolean } | null>;
}
