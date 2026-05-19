/** @format */
import type {
    ProfileAggInput,
    UserProfileRollupResult,
} from '../profile/computeUserProfileRollup.js';

export interface IUserProfileRollupRepository {
    /** ALL of the user's repository_profiles rows (pure fn applies scope). */
    listProfilesForRollup(userId: string): Promise<ProfileAggInput[]>;
    /** Upsert the precomputed rollup for the user (one row per user). */
    upsert(userId: string, result: UserProfileRollupResult): Promise<void>;
}
