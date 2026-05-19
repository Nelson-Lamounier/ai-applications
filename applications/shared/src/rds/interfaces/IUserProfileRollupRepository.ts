/** @format */
import type {
    ProfileAggInput,
    UserProfileRollupResult,
} from '../profile/computeUserProfileRollup.js';

export interface MirrorJson { readonly paragraph: string }
export interface RevealJson { readonly reveals: ReadonlyArray<{ insight: string; evidence: string }> }
export interface RollupRow {
  readonly rollup: unknown;
  readonly mirror: MirrorJson | null;
  readonly reveal: RevealJson | null;
  readonly refreshedAt: string;
  readonly synthesisRefreshedAt: string | null;
}

export interface IUserProfileRollupRepository {
    /** ALL of the user's repository_profiles rows (pure fn applies scope). */
    listProfilesForRollup(userId: string): Promise<ProfileAggInput[]>;
    /** Upsert the precomputed rollup for the user (one row per user). */
    upsert(userId: string, result: UserProfileRollupResult,
           mirror?: MirrorJson, reveal?: RevealJson): Promise<void>;
    /** Read the persisted rollup row for the user, or null if absent. */
    getRollup(userId: string): Promise<RollupRow | null>;
}
