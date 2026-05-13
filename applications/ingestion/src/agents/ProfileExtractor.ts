import { z } from 'zod';
import type { ProfileInputBundle } from './ProfileInputCollector.js';

export const ExtractedRepoDataSchema = z.object({
    project_name:  z.string().min(1).max(120),
    one_liner:     z.string().min(20).max(140),
    description:   z.string().min(40).max(800),
    domain:        z.enum(['web','ml','devops','infra','mobile','data','cli','lib','other']),
    tech_stack:    z.array(z.string()).max(20),
    role_inferred: z.enum(['creator','maintainer','contributor']),
    complexity:    z.enum(['simple','moderate','complex']),
    highlights:    z.array(z.string().max(280)).max(5),
    signals: z.object({
        has_readme:       z.boolean(),
        has_tests:        z.boolean(),
        has_ci:           z.boolean(),
        has_changelog:    z.boolean(),
        has_manifest:     z.boolean(),
        commit_count:     z.number().int().nonnegative(),
        primary_language: z.string().nullable(),
        last_active_at:   z.string().nullable(),
    }),
    confidence: z.number().min(0).max(1),
    missing:    z.array(z.string()).default([]),
});

export type ExtractedRepoData = z.infer<typeof ExtractedRepoDataSchema>;

export class ProfileExtractionError extends Error {
    constructor(
        public readonly code: 'no_tool_use_block' | 'schema_validation_failed' | 'bedrock_error',
        message: string,
    ) {
        super(message);
        this.name = 'ProfileExtractionError';
    }
}

// Full class implementation added in Task 8.
export class ProfileExtractor {
    readonly version = '1';

    extract(_userId: string, _bundle: ProfileInputBundle): Promise<ExtractedRepoData> {
        throw new Error('ProfileExtractor: not yet implemented');
    }
}
