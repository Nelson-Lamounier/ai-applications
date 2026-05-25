/** @format */
import type { RawImportEntry } from '@bedrock/shared';

/** Candidate aliases (lowercased, deduped). Collisions filtered separately. */
export function generateAliases(entry: RawImportEntry, ecosystem: string): string[] {
    const out = new Set<string>();
    const add = (s: string | undefined): void => {
        if (!s) return;
        const v = s.toLowerCase().trim();
        if (v) out.add(v);
    };
    add(entry.proposed_canonical_name);
    add(entry.proposed_display_name);
    add(entry.proposed_display_name.replace(/\s+/g, ''));
    add(entry.proposed_display_name.replace(/\s+/g, '-'));
    if (ecosystem === 'npm') {
        const base = entry.proposed_canonical_name;
        add(`${base}.js`);
        add(`${base}js`);
    }
    return [...out];
}
