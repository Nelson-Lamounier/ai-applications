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
});

export type AtsCheckResult = z.infer<typeof AtsCheckResultSchema>;
