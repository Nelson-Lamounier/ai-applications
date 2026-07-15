/**
 * @format
 * Deterministic skills-agent guards: ledger-membership validation for the
 * model's draft, plus a fully-deterministic fallback that never calls the
 * model at all.
 *
 * MEMBERSHIP CONTRACT (hard): every skill the model emits must resolve to a
 * ledger tool the matcher classified `verified` or `transferable` -- a `gap`
 * tool is EXCLUDED (the ledger's own honesty model already marks it as
 * unsupported; the skills list must never contradict that by naming it
 * anyway). Resolution reuses `matchTier1` bidirectionally (JD term vs ledger
 * tool text, either direction) plus an exact-lowercase check for names
 * `matchTier1`'s tokenizer would otherwise miss (e.g. very short acronyms).
 */
import type { JdSignal, SkillEvidenceEntry, TechnologyInventory } from '@bedrock/shared';
import { matchTier1 } from '../../ats/matching/keyword-match.js';
import type { SkillCategory, SkillsAgentOutput } from './skills-schema.js';

const MAX_CATEGORIES = 5;
const MAX_ITEMS_PER_CATEGORY = 8;

/** Bidirectional matchTier1 (either side may be the "term", either the "haystack") plus exact-lowercase. */
function skillMatchesTool(skillName: string, tool: string): boolean {
    if (skillName.trim().toLowerCase() === tool.trim().toLowerCase()) return true;
    return matchTier1(skillName, tool) || matchTier1(tool, skillName);
}

/**
 * Validate the model's draft against the Skill Evidence Ledger. Returns
 * machine-readable violation tokens; empty array = valid.
 *   - `unknown_skill:<name>`   -- no verified/transferable ledger tool matches
 *   - `category_cap:<n>`       -- more than 5 categories emitted
 *   - `item_cap:<category>:<n>` -- a category has more than 8 items
 */
export function validateSkillsMembership(out: SkillsAgentOutput, ledger: readonly SkillEvidenceEntry[]): string[] {
    const violations: string[] = [];
    const allowedTools = ledger.filter((e) => e.status === 'verified' || e.status === 'transferable').map((e) => e.tool);

    if (out.skills.length > MAX_CATEGORIES) violations.push(`category_cap:${out.skills.length}`);

    for (const category of out.skills) {
        if (category.skills.length > MAX_ITEMS_PER_CATEGORY) {
            violations.push(`item_cap:${category.category}:${category.skills.length}`);
        }
        for (const skillName of category.skills) {
            const matched = allowedTools.some((tool) => skillMatchesTool(skillName, tool));
            if (!matched) violations.push(`unknown_skill:${skillName}`);
        }
    }

    return violations;
}

/** The four JD technologyInventory buckets that map onto a skills category, in priority order. */
const INVENTORY_BUCKETS: ReadonlyArray<{ key: 'languages' | 'frameworks' | 'infrastructure' | 'tools'; label: string }> = [
    { key: 'languages', label: 'Languages' },
    { key: 'frameworks', label: 'Frameworks' },
    { key: 'infrastructure', label: 'Infrastructure' },
    { key: 'tools', label: 'Tools' },
];

const CORE_SKILLS_LABEL = 'Core Skills';

function inventoryHasAny(inventory: TechnologyInventory): boolean {
    return INVENTORY_BUCKETS.some((b) => inventory[b.key].length > 0);
}

/** The first inventory bucket whose entries name `tool`, or null (goes to the Core Skills catch-all). */
function bucketFor(tool: string, inventory: TechnologyInventory): string | null {
    for (const b of INVENTORY_BUCKETS) {
        if (inventory[b.key].some((named) => skillMatchesTool(tool, named))) return b.label;
    }
    return null;
}

/**
 * Fully-deterministic skills fallback -- no model call. Verified ledger tools
 * first, then transferable (ledger order preserved within each), grouped by
 * JD technologyInventory bucket membership when the inventory names any tool
 * at all; otherwise every tool lands in a single 'Core Skills' category.
 * Capped at 5 categories x 8 items -- the fixed bucket set (4 inventory
 * buckets + Core Skills) already caps at 5, so the cap only ever trims items.
 */
export function deterministicSkills(ledger: readonly SkillEvidenceEntry[], jd: JdSignal): SkillCategory[] {
    const orderedTools = [
        ...ledger.filter((e) => e.status === 'verified'),
        ...ledger.filter((e) => e.status === 'transferable'),
    ].map((e) => e.tool);

    if (orderedTools.length === 0) return [];

    if (!inventoryHasAny(jd.technologyInventory)) {
        return [{ category: CORE_SKILLS_LABEL, skills: orderedTools.slice(0, MAX_ITEMS_PER_CATEGORY) }];
    }

    const bucketed = new Map<string, string[]>();
    const core: string[] = [];
    for (const tool of orderedTools) {
        const label = bucketFor(tool, jd.technologyInventory);
        if (label) {
            const items = bucketed.get(label) ?? [];
            items.push(tool);
            bucketed.set(label, items);
        } else {
            core.push(tool);
        }
    }

    const categories: SkillCategory[] = [];
    for (const b of INVENTORY_BUCKETS) {
        const items = bucketed.get(b.label);
        if (items && items.length > 0) categories.push({ category: b.label, skills: items.slice(0, MAX_ITEMS_PER_CATEGORY) });
    }
    if (core.length > 0) categories.push({ category: CORE_SKILLS_LABEL, skills: core.slice(0, MAX_ITEMS_PER_CATEGORY) });

    return categories.slice(0, MAX_CATEGORIES);
}
