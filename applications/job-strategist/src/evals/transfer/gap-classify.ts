/**
 * @format
 * Pure, deterministic classifier for the transfer gap-rate eval (P0 Task 6).
 *
 * Given a stored JD gap skill string, decides whether it is:
 *  - `direct-evidence` — the candidate already has code/IaC/SBOM evidence for the
 *    canonical technology itself. Surfacing this as a "gap" upstream would be a
 *    false gap.
 *  - `transfer-convertible` — no direct evidence, but the canonical belongs to a
 *    TYPED transfer group (a `technology_relationships` component carrying a
 *    non-null `transferClass`, migration 120) alongside an evidenced sibling.
 *  - `honest-gap` — neither of the above. No evidence, and either no group
 *    contains it or only an UNTYPED (category-fallback) group does — untyped
 *    groups carry no verified transfer relationship and must never manufacture
 *    a transfer.
 *
 * No I/O, no Bedrock. Zero LLM. Reused by `run-gap-rate-eval.ts` per stored gap.
 */
import type { TechTransferGroup, TransferTier } from '@bedrock/shared';

export type GapClassificationKind = 'direct-evidence' | 'transfer-convertible' | 'honest-gap';

export interface GapClassification {
    readonly classification: GapClassificationKind;
    /** Lowercased canonical name the skill string resolved to. */
    readonly canonical: string;
    /** The evidenced sibling canonical this gap converts through (transfer-convertible only). */
    readonly via?: string;
    /** The typed transfer group's class (transfer-convertible only). */
    readonly transferClass?: string;
    /** The typed transfer group's tier (transfer-convertible only). */
    readonly transferTier?: TransferTier;
}

/** Lowercase + alias-map lookup. Accepts either a live `Map` (as returned by
 *  `TechnologyOntologyRepository.loadAliasToCanonicalMap()`) or a plain
 *  `Record` (JSON-friendly, e.g. loaded from a fixture). Unmapped terms fall
 *  back to their lowercased, trimmed form — no further normalisation. */
function canonicaliseSkill(
    skill: string,
    aliasToCanonical: Map<string, string> | Record<string, string>,
): string {
    const lower = skill.toLowerCase().trim();
    const mapped = aliasToCanonical instanceof Map
        ? aliasToCanonical.get(lower)
        : aliasToCanonical[lower];
    return mapped ?? lower;
}

/**
 * Classify one JD gap skill against the user's evidenced canonicals and the
 * ontology's typed transfer groups.
 *
 * Only groups carrying a non-null `transferClass` (typed, migration-120 edges)
 * can convert a gap — untyped/category-fallback groups (`loadCategoryGroups()`,
 * or an untyped `loadTransferGroups()` component) are skipped entirely, so a
 * shared category never manufactures a transfer claim.
 */
export function classifyGap(
    skill: string,
    evidenced: ReadonlySet<string>,
    groups: readonly TechTransferGroup[],
    aliasToCanonical: Map<string, string> | Record<string, string>,
): GapClassification {
    const canonical = canonicaliseSkill(skill, aliasToCanonical);

    if (evidenced.has(canonical)) {
        return { classification: 'direct-evidence', canonical };
    }

    for (const group of groups) {
        if (group.transferClass === null) continue; // untyped groups never convert
        if (!group.members.includes(canonical)) continue;

        const via = group.members.find((member) => member !== canonical && evidenced.has(member));
        if (via !== undefined) {
            return {
                classification: 'transfer-convertible',
                canonical,
                via,
                transferClass: group.transferClass,
                ...(group.transferTier ? { transferTier: group.transferTier } : {}),
            };
        }
    }

    return { classification: 'honest-gap', canonical };
}
