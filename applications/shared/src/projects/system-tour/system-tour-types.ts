/**
 * @format
 * Zod schema + TS type for the per-project System Tour (S7a).
 *
 * A System Tour is a grounded re-projection of an already-generated
 * `CaseStudy` into the narrative order a candidate would present during an
 * architecture-review interview round: what the system is (area), why it
 * exists (context), the key decisions, the tradeoffs, the system map, the
 * outcomes, and — the one genuinely-new synthesis — what they'd change.
 *
 * The shape deliberately reuses `ArchitectureSchema` from
 * `case-study-types.ts` for `systemMap`: the tour must render the case
 * study's already-grounded Mermaid architecture verbatim, never invent a
 * new diagram.
 */
import { z } from 'zod';

import { ArchitectureSchema } from '../case-study/case-study-types.js';

// ─── System-tour payload ─────────────────────────────────────────────────────

const KeyDecisionSchema = z.object({
    decision:  z.string().min(1).max(2000),
    rationale: z.string().min(1).max(2000),
}).strict();
export type KeyDecision = z.infer<typeof KeyDecisionSchema>;

const TradeoffSchema = z.object({
    tension:    z.string().min(1).max(2000),
    chosenPath: z.string().min(1).max(2000),
    cost:       z.string().min(1).max(2000),
}).strict();
export type Tradeoff = z.infer<typeof TradeoffSchema>;

export const SystemTourSchema = z.object({
    /** The system/component the tour walks. */
    area:    z.string().min(1).max(200),
    /** Problem + constraints, grounded in the case study. */
    context: z.string().min(1).max(2000),
    /** From the case study's `decisions`. At least one; at most six. */
    keyDecisions: z.array(KeyDecisionSchema).min(1).max(6),
    /** From the case study's `challenges`. At most six. */
    tradeoffs:    z.array(TradeoffSchema).max(6),
    /** REUSE the case study's Mermaid `architecture` verbatim. */
    systemMap:    ArchitectureSchema,
    /** From the case study's `highlights`. At most six. */
    outcomes:     z.array(z.string().min(1).max(2000)).max(6),
    /**
     * NEW — grounded improvements only, drawn from evidenced limitations
     * (case-study `challenges` / `depthMarkers`). May be `[]` when none;
     * never fabricated regrets. At most four.
     */
    whatIdChange: z.array(z.string().min(1).max(2000)).max(4),
}).strict();
export type SystemTour = z.infer<typeof SystemTourSchema>;
