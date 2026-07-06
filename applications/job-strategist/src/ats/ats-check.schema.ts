/** @format */
import { z } from 'zod';

export const AtsKeywordCoverageSchema = z.object({
    term:     z.string(),
    present:  z.boolean(),
    grounded: z.boolean(),
    tier:     z.enum(['literal', 'normalized', 'ontology', 'tech-transfer', 'embedding', 'none']).default('none'),
});

export const AtsCheckResultSchema = z.object({
    machineReadable:          z.boolean(),
    standardSectionsDetected: z.array(z.string()),
    contactDetected:          z.object({ name: z.string(), email: z.string() }),
    parseBreakers:            z.array(z.string()),
    jdKeywordCoverage:        z.array(AtsKeywordCoverageSchema),
    status:                   z.enum(['passed', 'issues', 'unverified']),
    passed:                   z.boolean(),
    issues:                   z.array(z.string()),
    // ── ATS feedback loop pass-mark (additive, optional for back-compat) ──
    // Attainable = ledger entries the candidate has (verified) or can transfer
    // (transferable); gaps are excluded. `surfacedKeywords` are the tools fed to
    // the one bounded honest re-write before the final render.
    attainableTotal:          z.number().optional(),
    attainableCovered:        z.number().optional(),
    attainablePassed:         z.boolean().optional(),
    surfacedKeywords:         z.array(z.string()).optional(),
    // True when the surfaced-keyword re-check failed (after a retry) and this
    // verdict describes the PRE-rewrite resume — issues/coverage may not match
    // the persisted resume text. Consumers must not present stale issues as
    // current findings.
    staleForFinalResume:      z.boolean().optional(),
    // Rendered PDF page count — ground truth for the 2-page maximum.
    pageCount:                z.number().optional(),
});

export type AtsCheckResult = z.infer<typeof AtsCheckResultSchema>;
