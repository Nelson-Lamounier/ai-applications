/** @format */
import type { RawTechnologyEvidence } from '../extractors/Extractor.js';
import { PARSER_SPECS } from './manifest-parsers.js';

/** ecosystem (syft type) -> the spec that owns its name normalisation. */
const SPEC_BY_ECOSYSTEM = new Map(
    PARSER_SPECS.flatMap((s) => s.syftEcosystems.map((e) => [e, s] as const)),
);

/**
 * Keep only directly-declared dependencies among syft rows. A row is kept when:
 *  - it is not a syft row (untouched), OR
 *  - its ecosystem has no direct-set (fail-open: no parser / no manifest), OR
 *  - its normalised name is in that ecosystem's direct-set.
 * Transitive syft rows (in the lockfile but not any manifest) are dropped.
 */
export function filterSyftDirect(
    rows: readonly RawTechnologyEvidence[],
    directByEcosystem: ReadonlyMap<string, ReadonlySet<string>>,
): RawTechnologyEvidence[] {
    return rows.filter((r) => {
        if (r.source_layer !== 'syft') return true;
        const eco = r.ecosystem;
        if (!eco) return true;
        const direct = directByEcosystem.get(eco);
        if (!direct) return true; // fail-open
        const spec = SPEC_BY_ECOSYSTEM.get(eco);
        const normalised = spec ? spec.normalise(r.raw_name) : r.raw_name.trim().toLowerCase();
        return direct.has(normalised);
    });
}
