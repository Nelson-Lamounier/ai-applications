/** @format */
import type { CompanyType } from '@bedrock/shared';
import type { ResolvedRole } from './resolve-role-families.js';

const HEADER = [
    'ROLE EVIDENCE — use to TRANSLATE the candidate\'s real work into the target',
    'role\'s vocabulary. You may surface a term ONLY when a highlight demonstrates it;',
    'never claim a responsibility the highlights don\'t support, and never name or',
    'apologise for any gap.',
].join('\n');

/** Format matched role families into a grounding block (sibling of projectEvidenceBlock). */
export function formatRoleEvidence(resolved: ResolvedRole[], companyFraming: Map<CompanyType, string> = new Map()): string {
    const matched = resolved.filter((r) => r.family !== null);
    if (matched.length === 0) return '';
    const lines: string[] = [HEADER];
    for (const r of matched) {
        const f = r.family;
        if (!f) continue;
        lines.push(
            `- ${r.title} @ ${r.company}  [${f.roleClass}]`,
            `  transferable: ${f.transferableSkills.join(', ')}`,
            `  vocabulary: ${f.vocabulary.join(', ')}`,
        );
        const note = (r.companyType && companyFraming.get(r.companyType)) ?? f.industryNotes;
        if (note) lines.push(`  note: ${note}`);
    }
    return lines.join('\n');
}
