/** @format */
import type { RoleFamily, CompSeniority } from './stage-prep-types.js';

/** Ordered keyword → family. First match wins; devops before backend so "platform" maps right. */
const ROLE_KEYWORDS: ReadonlyArray<readonly [RegExp, RoleFamily]> = [
    [/\b(devops|sre|platform|infra(structure)?|reliability)\b/i, 'devops'],
    [/\b(machine learning|ml engineer|ml\b|mlops|ai engineer)\b/i, 'ml'],
    [/\b(data engineer|data platform|analytics engineer)\b/i, 'data'],
    [/\b(front[- ]?end|react|ui engineer)\b/i, 'frontend'],
    [/\b(mobile|ios|android)\b/i, 'mobile'],
    [/\b(back[- ]?end|server|api|golang|node|java|python engineer)\b/i, 'backend'],
];

export function toRoleFamily(title: string): RoleFamily {
    for (const [re, fam] of ROLE_KEYWORDS) if (re.test(title)) return fam;
    return '*';
}

const COMP_LEVELS: ReadonlySet<string> = new Set(['junior', 'mid', 'senior', 'staff', 'principal']);

export function toCompSeniority(stage: string | null): CompSeniority {
    return stage && COMP_LEVELS.has(stage) ? (stage as CompSeniority) : 'mid';
}
