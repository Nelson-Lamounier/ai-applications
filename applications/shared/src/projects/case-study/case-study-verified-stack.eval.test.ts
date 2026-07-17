/** @format */
/**
 * Eval: SBOM-grounded stack (CLAUDE.md rule 5 — per-phase eval before scaling).
 *
 * "Good output" for this phase:
 *   1. Integrity — every stamped verifiedTech with a version carries a
 *      fully-qualified purl (`...@<version>`). A version that isn't reflected
 *      in the purl would be a lie on the recruiter-facing badge.
 *   2. Grounding rate — given a realistic generated stack drawn from the
 *      verifiedStack we feed the model, the share of items that resolve to a
 *      real code dependency must clear a floor. A low rate means the prompt
 *      rule isn't biting (the model is inventing tech).
 *   3. Honest flagging — an invented dependency with no other evidence is
 *      marked NOT_GROUNDED, never silently stamped.
 */
import { describe, it, expect } from '@jest/globals';
import {
    buildVerifiedStackMap,
    stampStackSignals,
    type VerifiedTechRow,
} from './case-study-verified-stack.js';
import type { SourceSignal } from './case-study-types.js';

const empty = (): SourceSignal => ({ commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED' });

// A realistic per-repo evidence slice (Syft versions + IaC/Docker bare purls).
const EVIDENCE: VerifiedTechRow[] = [
    { canonicalName: 'React',       version: '18.3.1',  purl: 'pkg:npm/react@18.3.1',           filePath: 'package.json', lineStart: 24 },
    { canonicalName: 'TypeScript',  version: '5.4.5',   purl: 'pkg:npm/typescript@5.4.5',       filePath: 'package.json', lineStart: 51 },
    { canonicalName: 'Express',     version: '4.19.2',  purl: 'pkg:npm/express@4.19.2',         filePath: 'package.json', lineStart: 33 },
    { canonicalName: 'Zod',         version: '3.23.8',  purl: 'pkg:npm/zod@3.23.8',             filePath: 'package.json', lineStart: 40 },
    { canonicalName: 'PostgreSQL',  version: null,      purl: 'pkg:generic/postgresql',         filePath: 'docker-compose.yml', lineStart: 12 },
    { canonicalName: 'Terraform',   version: null,      purl: 'pkg:generic/terraform',          filePath: 'infra/main.tf', lineStart: 1 },
    { canonicalName: 'Docker',      version: null,      purl: 'pkg:generic/docker',             filePath: 'Dockerfile', lineStart: 1 },
];

// Stack names a well-behaved agent would emit, drawn from <verifiedStack>, plus
// one honest invention the prompt should have suppressed.
const GENERATED_STACK = ['React', 'typescript', 'Express', 'Zod', 'PostgreSQL', 'Terraform', 'Docker', 'Kafka'];

describe('eval: SBOM-grounded stack', () => {
    const map = buildVerifiedStackMap(EVIDENCE);
    const stamped = GENERATED_STACK.map((name) => ({ name, signals: stampStackSignals(name, empty(), map) }));

    it('integrity: every versioned stamp has a fully-qualified purl', () => {
        for (const { name, signals } of stamped) {
            for (const vt of signals.verifiedTech ?? []) {
                if (vt.version != null) {
                    expect(vt.purl).not.toBeNull();
                    expect(vt.purl).toContain(`@${vt.version}`);
                    // name carries no version (deterministic stamp owns it)
                    expect(name).not.toContain('@');
                }
            }
        }
    });

    it('grounding rate clears the 0.8 floor on a verifiedStack-drawn stack', () => {
        const matched = stamped.filter((s) => (s.signals.verifiedTech?.length ?? 0) > 0).length;
        const rate = matched / stamped.length;
        expect(rate).toBeGreaterThanOrEqual(0.8); // 7/8 = 0.875
    });

    it('honest flagging: the lone invention is the only NOT_GROUNDED item', () => {
        const flagged = stamped.filter((s) => s.signals.grounding === 'NOT_GROUNDED').map((s) => s.name);
        expect(flagged).toEqual(['Kafka']);
    });
});
