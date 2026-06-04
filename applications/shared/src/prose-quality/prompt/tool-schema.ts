/**
 * @format
 * Forced-tool schema for the prose linter — the single tight output contract for
 * this phase (one variant, not a shared loose schema). Mirrors ProseQualityResult.
 */
const SCORE_DIMENSION = { type: 'integer', minimum: 1, maximum: 10 } as const;

export const PROSE_QUALITY_TOOL = {
    name: 'emit_prose_quality',
    description: 'Emit the prose-quality verdict: 5-dimension score + AI-tell issues.',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['PASS', 'FAIL'] },
            score: {
                type: 'object',
                properties: {
                    directness:   SCORE_DIMENSION,
                    rhythm:       SCORE_DIMENSION,
                    trust:        SCORE_DIMENSION,
                    authenticity: SCORE_DIMENSION,
                    density:      SCORE_DIMENSION,
                    total:        { type: 'integer', minimum: 5, maximum: 50 },
                },
                required: ['directness', 'rhythm', 'trust', 'authenticity', 'density', 'total'],
                additionalProperties: false,
            },
            belowThreshold: { type: 'boolean' },
            issues: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        category: { type: 'string', enum: ['phrase', 'structure'] },
                        match:    { type: 'string' },
                        location: { type: 'string' },
                        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                        rule:     { type: 'string' },
                    },
                    required: ['category', 'match', 'location', 'severity', 'rule'],
                    additionalProperties: false,
                },
            },
        },
        required: ['status', 'score', 'belowThreshold', 'issues'],
        additionalProperties: false,
    },
} as const;
