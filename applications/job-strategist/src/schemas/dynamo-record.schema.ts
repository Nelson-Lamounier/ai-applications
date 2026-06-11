/**
 * @format
 * Pipeline Record Schemas — Zod Runtime Validation
 *
 * Validates analysis record shapes consumed by the job-strategist pipeline.
 * Originally backed by DynamoDB; now sourced from RDS pipeline_runs metadata.
 * Replaces unsafe casts with strict schema-based parsing at retrieval boundaries.
 *
 * @see pipeline-runs.ts — updatePipelineRunMetadata
 * @see coach-agent.ts — AnalysisRecordSchema
 */

import { z } from 'zod';

// =============================================================================
// DOMAIN ENUMS (RUNTIME)
// =============================================================================

/**
 * Fit rating values — runtime-validated variant of the `FitRating` union type.
 */
export const FIT_RATINGS = [
    'STRONG FIT',
    'REASONABLE FIT',
    'STRETCH',
    'REACH',
] as const;

/**
 * Application recommendation values — runtime-validated variant
 * of the `ApplicationRecommendation` union type.
 */
export const APPLICATION_RECOMMENDATIONS = [
    'APPLY',
    'APPLY WITH CAVEATS',
    'STRETCH APPLICATION',
    'NOT RECOMMENDED',
] as const;

export const FitRatingSchema = z.enum(FIT_RATINGS);
export const ApplicationRecommendationSchema = z.enum(APPLICATION_RECOMMENDATIONS);

// =============================================================================
// RESUME SUGGESTIONS (NESTED IN ANALYSIS RECORD)
// =============================================================================

/** Addition suggestion within the analysis record */
const AdditionSuggestionSchema = z.object({
    section: z.string(),
    suggestedBullet: z.string(),
    sourceCitation: z.string(),
});

/** Reframe suggestion within the analysis record */
const ReframeSuggestionSchema = z.object({
    original: z.string(),
    suggested: z.string(),
    rationale: z.string(),
});

/** ESL correction within the analysis record */
const EslCorrectionSchema = z.object({
    original: z.string(),
    corrected: z.string(),
});

/** Resume suggestions aggregate */
const ResumeSuggestionsSchema = z.object({
    additions: z.array(AdditionSuggestionSchema).default([]),
    reframes: z.array(ReframeSuggestionSchema).default([]),
    eslCorrections: z.array(EslCorrectionSchema).default([]),
});

// =============================================================================
// ANALYSIS METADATA (NESTED IN ANALYSIS RECORD)
// =============================================================================

/** Metadata sub-object within the analysis pipeline_runs record */
const AnalysisMetadataSchema = z.object({
    candidateName: z.string().default(''),
    targetRole: z.string().default(''),
    targetCompany: z.string().default(''),
    analysisDate: z.string().default(''),
    overallFitRating: FitRatingSchema.catch('STRETCH'),
    applicationRecommendation: ApplicationRecommendationSchema.catch('APPLY WITH CAVEATS'),
});

// =============================================================================
// ANALYSIS RECORD (PIPELINE_RUNS METADATA)
// =============================================================================

/**
 * Schema for the analysis payload stored in pipeline_runs.metadata.
 *
 * Validates all fields with `.default()` / `.catch()` for backward-compatible
 * parsing of records produced by different pipeline versions.
 */
export const AnalysisRecordSchema = z.object({
    /** Pipeline run ID — corresponds to pipeline_runs.id */
    sk: z.string(),

    /** Full XML analysis output */
    analysisXml: z.string(),

    /** Extracted metadata for quick queries */
    metadata: AnalysisMetadataSchema,

    /** Generated cover letter (structured object, null when not requested) */
    coverLetter: z.object({
        greeting:   z.string(),
        paragraphs: z.array(z.string()),
        signoff:    z.object({ name: z.string(), email: z.string(), linkedin: z.string(), github: z.string() }),
    }).nullable().default(null),

    /** Structured per-item resume suggestions */
    resumeSuggestions: ResumeSuggestionsSchema.default({
        additions: [],
        reframes: [],
        eslCorrections: [],
    }),

    /** @deprecated — backward-compatible count fields */
    resumeAdditions: z.number().default(0),
    /** @deprecated — backward-compatible count fields */
    resumeReframes: z.number().default(0),
    /** @deprecated — backward-compatible count fields */
    eslCorrections: z.number().default(0),
});

// =============================================================================
// APPLICATION METADATA RECORD
// =============================================================================

/**
 * Schema for the application metadata stored in pipeline_runs.metadata.
 *
 * Used to reconstruct pipeline context when starting the coaching pipeline
 * for an existing application. Only validates fields read by the handler.
 */
export const ApplicationMetadataRecordSchema = z.object({
    /** Job description text (stored with the analysis) */
    jobDescription: z.string().default(''),
    /** Target company name */
    targetCompany: z.string().default(''),
    /** Target role title */
    targetRole: z.string().default(''),
    /** Resume ID used in the original analysis */
    resumeId: z.string().default(''),
    /** Authenticated user ID — used for KB metadata filtering */
    userId: z.string().default(''),
});

// =============================================================================
// INFERRED TYPES
// =============================================================================

/** Validated analysis record from pipeline_runs metadata */
export type ValidatedAnalysisRecord = z.infer<typeof AnalysisRecordSchema>;

/** Validated analysis metadata sub-object */
export type ValidatedAnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>;

/** Validated application metadata record */
export type ValidatedApplicationMetadata = z.infer<typeof ApplicationMetadataRecordSchema>;
