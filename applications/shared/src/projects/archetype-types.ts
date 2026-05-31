/** @format */

export const ARCHETYPE_IDS = [
    'production_saas', 'open_source_library', 'internal_tool', 'ml_research',
    'devops_infra', 'monorepo', 'cli_tool', 'mobile_app', 'static_site',
] as const;
export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

export const STAGE_IDS = ['junior', 'mid', 'senior', 'staff'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface ClassificationSignals {
    readonly required_any?: readonly string[];
    readonly positive?:     readonly string[];
    readonly negative?:     readonly string[];
}

export interface ArchetypeDef {
    readonly id:                    string;
    readonly name:                  string;
    readonly description:           string;
    readonly classificationSignals: ClassificationSignals;
    readonly expectedSections:      readonly string[];
    readonly expectedArtifacts:     readonly string[];
}

export interface StageOverlay {
    readonly archetypeId:          string;
    readonly stage:                StageId;
    readonly prioritySections:     readonly string[];
    readonly deemphasizedSections: readonly string[];
    readonly stageSuggestions:     ReadonlyArray<{ title: string; description: string }>;
}

/** Inputs the classifier reads — all already available to the loader. */
export interface ClassifyRepoInput {
    readonly primaryLanguage: string | null;
    readonly topics:          readonly string[];
    readonly techStack:       readonly string[];
    readonly filePaths:       readonly string[];
}

export interface ClassifyInput {
    readonly projectType:  string;
    readonly projectShape: string;
    readonly repos:        readonly ClassifyRepoInput[];
}
