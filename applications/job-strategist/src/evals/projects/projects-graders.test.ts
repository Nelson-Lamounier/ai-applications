/** @format */
import { describe, it, expect } from '@jest/globals';
import type { StructuredResumeData } from '@bedrock/shared';
import {
    runProjectsGraders,
    provenanceGrader,
    quoteFidelityGrader,
    compositionGrader,
    atsCoverageGrader,
    descriptionGrader,
    styleGrader,
} from './projects-graders.js';
import {
    GOLDEN_TWO_LANE, ADVERSARIAL_CROSS_PROJECT, ADVERSARIAL_RETYPED_QUOTE, ADVERSARIAL_OVER_CAP_COMPOSED,
    ADVERSARIAL_UNKNOWN_ID, ADVERSARIAL_CROSS_PROJECT_COMPOSED, ADVERSARIAL_EMPTY_POOL,
    K8S_ORDERING_TARGETS, K8S_ORDERING_POOL,
    LANE_MIX_TARGETS, LANE_MIX_CURATED_WINS, LANE_MIX_COMPOSED_WINS,
    ALL_COMPOSED_UNCAPPED,
    STRINGIFIED_ENTRIES_RAW_PAYLOAD,
    STYLE_DIRTY_COMPOSED, STYLE_DIRTY_CURATED,
} from './fixtures.js';
import { normaliseProjectsAgentOutput, ProjectsAgentOutputSchema, isCurated } from '../../agents/writer/projects-schema.js';
import { assembleProjects } from '../../agents/writer/projects-provenance.js';
import { deterministicProjects, scoreProjectsCoverage } from '../../agents/writer/projects-ats-flow.js';
import { stampProjectDescription } from '../../agents/writer/projects-description.js';
import { withProjectsDescriptionLock } from '../../agents/writer/experience-lock.js';

describe('projects graders', () => {
    it('the golden two-lane (staleness) output passes every grader', () => {
        const r = runProjectsGraders(GOLDEN_TWO_LANE);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('a cross-project curated citation fails ONLY provenanceGrader', () => {
        const r = runProjectsGraders(ADVERSARIAL_CROSS_PROJECT);
        expect(provenanceGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(false);
        expect(quoteFidelityGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(compositionGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(descriptionGrader(ADVERSARIAL_CROSS_PROJECT).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['provenance']);
        expect(r.pass).toBe(false);
    });

    it('a retyped curated bullet in the rendered text fails ONLY quoteFidelityGrader', () => {
        const r = runProjectsGraders(ADVERSARIAL_RETYPED_QUOTE);
        expect(provenanceGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(quoteFidelityGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(false);
        expect(compositionGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(descriptionGrader(ADVERSARIAL_RETYPED_QUOTE).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['quoteFidelity']);
        expect(r.pass).toBe(false);
    });

    it('seven composed bullets for one project (one over the Task 3 raised per-entry cap) fails '
        + 'provenanceGrader AND compositionGrader (shared cap invariant), nothing else', () => {
        const r = runProjectsGraders(ADVERSARIAL_OVER_CAP_COMPOSED);
        expect(provenanceGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(false);
        expect(quoteFidelityGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(true);
        expect(compositionGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(false);
        expect(atsCoverageGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(true);
        expect(descriptionGrader(ADVERSARIAL_OVER_CAP_COMPOSED).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader).sort()).toEqual(['composition', 'provenance']);
        expect(r.pass).toBe(false);
    });

    it('atsCoverage passes vacuously when a fixture has no ATS targets', () => {
        const r = atsCoverageGrader({ ...GOLDEN_TWO_LANE, atsTargets: [] });
        expect(r.pass).toBe(true);
    });

    // FIX 3: re-derived to drive the failure through `output`/`pool` (what
    // `scoreProjectsCoverage` actually scores) rather than a swapped
    // `assembled` render -- since the grader no longer reads `assembled` at
    // all, a stale render swap would no longer exercise a real failure.
    it('atsCoverage fails when the output has no highlights left to cover any target', () => {
        const noHighlights = { entries: GOLDEN_TWO_LANE.output.entries.map((e) => ({ ...e, highlights: [] })) };
        const r = atsCoverageGrader({ ...GOLDEN_TWO_LANE, output: noHighlights });
        expect(r.pass).toBe(false);
    });
});

// Component 4 (c): style guard graders -- reuses checkComposedBulletStyle via
// projectsStyleDiagnostics, no parallel pattern logic.
describe('styleGrader (Component 3/4)', () => {
    it('fails ONLY styleGrader when a COMPOSED bullet leaks an internal identifier '
        + '-- "(RETRIEVAL_PREFILTER)", the run fe421faf leak', () => {
        const r = runProjectsGraders(STYLE_DIRTY_COMPOSED);
        expect(provenanceGrader(STYLE_DIRTY_COMPOSED).pass).toBe(true);
        expect(quoteFidelityGrader(STYLE_DIRTY_COMPOSED).pass).toBe(true);
        expect(compositionGrader(STYLE_DIRTY_COMPOSED).pass).toBe(true);
        expect(atsCoverageGrader(STYLE_DIRTY_COMPOSED).pass).toBe(true);
        expect(descriptionGrader(STYLE_DIRTY_COMPOSED).pass).toBe(true);
        expect(styleGrader(STYLE_DIRTY_COMPOSED).pass).toBe(false);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['style']);
        expect(r.pass).toBe(false);
    });

    it('the SAME internal-identifier pattern on a CURATED (quote-only) bullet is advisory-only -- '
        + 'styleGrader passes (curated bullets are never repaired at resume time)', () => {
        const r = runProjectsGraders(STYLE_DIRTY_CURATED);
        expect(styleGrader(STYLE_DIRTY_CURATED).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('the golden two-lane output has zero style findings', () => {
        expect(styleGrader(GOLDEN_TWO_LANE).pass).toBe(true);
    });
});

/** GOLDEN_TWO_LANE with entry 0's description swapped -- descriptionGrader
 *  reads only `output` + `pool`, so the stale `assembled` is irrelevant. */
function withDescription(description: string) {
    return {
        ...GOLDEN_TWO_LANE,
        output: {
            entries: [
                { ...GOLDEN_TWO_LANE.output.entries[0]!, description },
                GOLDEN_TWO_LANE.output.entries[1]!,
            ],
        },
    };
}

/** A properly-terminated `words`-word sentence, unique per `seed`. */
function sentenceOf(words: number, seed: number): string {
    return `${Array.from({ length: words - 1 }, (_, i) => `word${seed}x${i}`).join(' ')} ends.`;
}

// Stamp-contract boundary cases for descriptionGrader -- the grader is the
// idempotency check `stampProjectDescription(description, '', 80) ===
// description.trim()` (plus non-empty), so these prove the 80-word boundary
// and the mid-sentence-truncation rejection with the runtime primitive
// itself, not a re-derived word count.
describe('descriptionGrader stamp-contract boundaries', () => {
    it('PASSES an exactly-80-word multi-sentence stamp (four 20-word sentences)', () => {
        const eighty = [0, 1, 2, 3].map((n) => sentenceOf(20, n)).join(' ');
        expect(descriptionGrader(withDescription(eighty)).pass).toBe(true);
    });

    it('FAILS an 81-word multi-sentence description (the stamp would drop its last sentence)', () => {
        const eightyOne = [sentenceOf(20, 0), sentenceOf(20, 1), sentenceOf(20, 2), sentenceOf(21, 3)].join(' ');
        const r = descriptionGrader(withDescription(eightyOne));
        expect(r.pass).toBe(false);
        expect(r.failures).toContain('description_not_stamp_shaped:Tucaken');
    });

    it('FAILS a mid-sentence-truncated description (unterminated 85-word fragment the stamp would re-slice)', () => {
        const truncated = Array.from({ length: 85 }, (_, i) => `token${i}`).join(' ');
        const r = descriptionGrader(withDescription(truncated));
        expect(r.pass).toBe(false);
        expect(r.failures).toContain('description_not_stamp_shaped:Tucaken');
    });

    it('FAILS an empty description (the stamp never ships one -- fail-open leaves the prior value)', () => {
        const r = descriptionGrader(withDescription('   '));
        expect(r.pass).toBe(false);
        expect(r.failures).toContain('description_empty:Tucaken');
    });
});

// Task 5 (a): the run-1eda06eb-shaped over-emission -- a highlight carrying
// BOTH a bulletId and echoed text/sources -- must be accepted end to end:
// normalise-then-validate strips the extras, the schema parses cleanly, and
// the ASSEMBLED text is byte-identical to the pool's own curated bullet (the
// echoed `text` never reaches the resume, even if it were tampered).
describe('Task 5 (a): run-1eda06eb-shaped curated+sources payload is accepted end to end', () => {
    it('normalises, parses, and assembles byte-identical to the pool for both entries', () => {
        const raw = {
            entries: [
                {
                    name: 'Tucaken', github: 'github.com/o/tucaken-app', description: 'a model-authored pitch the pipeline discards',
                    highlights: [
                        { bulletId: 'p0.b1', text: 'a stale echo of the RLS bullet', sources: ['p0.b1'] },
                        { bulletId: 'p0.b2', text: 'a stale echo of the Postgres bullet', sources: ['p0.b2'] },
                        { text: 'Configured DNS resolution for every production deployment', sources: ['p0.r0'] },
                    ],
                },
                {
                    name: 'Portfolio', github: 'github.com/o/portfolio', description: 'another model-authored pitch',
                    highlights: [{ bulletId: 'p1.b0', text: 'a stale echo', sources: ['p1.b0'] }],
                },
            ],
        };

        const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);
        // 2 descriptions discarded + 3 bulletId+sources over-emissions stripped.
        expect(normalisedExtras).toBe(5);

        const parsed = ProjectsAgentOutputSchema.parse(output);
        expect(isCurated(parsed.entries[0]!.highlights[0]!)).toBe(true);
        expect(isCurated(parsed.entries[0]!.highlights[1]!)).toBe(true);
        expect(isCurated(parsed.entries[0]!.highlights[2]!)).toBe(false);

        const assembled = assembleProjects(parsed, GOLDEN_TWO_LANE.pool);
        expect(assembled[0]!.highlights[0]).toBe('Wrote the RLS policies for multi-tenant Kubernetes clusters');
        expect(assembled[0]!.highlights[1]).toBe('Instrumented PostgreSQL row-level security across every write path');
        expect(assembled[1]!.highlights[0]).toBe('Automated CI checks across every workspace');
    });
});

// Task 5 (b): bulletId is authoritative "regardless of what else is
// present" (normaliseHighlight's own doc comment) -- even when the echoed
// `sources` array names a DIFFERENT id than bulletId, the item still
// normalises to curated-by-bulletId-only. Distinct from (a): here the
// echoed fields actively DISAGREE with the authoritative id, not merely
// duplicate it.
describe('Task 5 (b): both-keys precedence -- bulletId wins even over a disagreeing sources array', () => {
    it('keeps only bulletId when text/sources point at a different, unrelated id', () => {
        const raw = {
            entries: [{
                name: 'Tucaken', github: 'github.com/o/tucaken-app', description: '',
                highlights: [{ bulletId: 'p0.b1', text: 'a fabricated tampered echo', sources: ['p0.r6'] }],
            }],
        };

        const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);
        expect(normalisedExtras).toBe(1);

        const parsed = ProjectsAgentOutputSchema.parse(output);
        expect(parsed.entries[0]!.highlights[0]).toEqual({ bulletId: 'p0.b1' });

        const assembled = assembleProjects(parsed, GOLDEN_TWO_LANE.pool);
        expect(assembled[0]!.highlights[0]).toBe('Wrote the RLS policies for multi-tenant Kubernetes clusters');
    });
});

// Task 5 (c): fail-closed provenance across three distinct violation
// branches -- an id that resolves nowhere, a COMPOSED cross-project
// citation (the curated/bulletId path is already covered by the existing
// ADVERSARIAL_CROSS_PROJECT fixture above), and a totally empty pool.
describe('Task 5 (c): fail-closed provenance -- unknown id / cross-project / empty pool', () => {
    it('rejects a composed source id that resolves nowhere in the pool', () => {
        const r = provenanceGrader(ADVERSARIAL_UNKNOWN_ID);
        expect(r.pass).toBe(false);
        expect(r.failures).toContain('unknown_bullet:Tucaken:p0.r99');
    });

    it('rejects a composed highlight citing another project\'s id', () => {
        const r = provenanceGrader(ADVERSARIAL_CROSS_PROJECT_COMPOSED);
        expect(r.pass).toBe(false);
        expect(r.failures).toContain('cross_project_citation:Tucaken:p1.b0');
    });

    it('rejects every entry when the pool documents nothing at all', () => {
        const r = provenanceGrader(ADVERSARIAL_EMPTY_POOL);
        expect(r.pass).toBe(false);
        expect(r.failures).toContain('unknown_project:Tucaken');
        expect(r.failures).toContain('unknown_project:Portfolio');
    });
});

// Task 5 (d): JD-ranked ordering -- `deterministicProjects` must reorder a
// pool listing the LESS JD-relevant project first (Frontend) so the
// K8s-flavoured target's project (Platform) ships first.
describe('Task 5 (d): K8s-flavoured targets rank the platform project above the frontend project in the fallback', () => {
    it('reorders Platform ahead of Frontend despite Frontend being listed first in the pool', () => {
        const result = deterministicProjects(K8S_ORDERING_POOL, K8S_ORDERING_TARGETS);
        expect(result.map((r) => r.name)).toEqual(['Platform', 'Frontend']);
    });
});

// Task 5 (e): description = the deterministic pitch stamp
// (`stampProjectDescription`), and it survives a simulated downstream
// guard/condense mutation via `withProjectsDescriptionLock` -- the two
// runtime primitives Task 2 shipped, exercised together end to end.
describe('Task 5 (e): description = pitch stamp, survives a simulated guard/condense mutation via the lock', () => {
    it('reverts a guard-repair rewrite of the stamped description, keeping the highlight trim the same pass made', async () => {
        const pitch = 'career platform helping engineers land jobs faster through evidence grounded coaching';
        const stamped = stampProjectDescription(pitch);
        expect(stamped.length).toBeGreaterThan(0);

        const resume = {
            profile:         { name: 'N', title: 'Engineer', email: 'e', location: 'Dublin' },
            summary:         'Ships production AI systems.',
            experience:      [],
            skills:          [],
            education:       [],
            certifications:  [],
            projects:        [{ name: 'Tucaken', description: stamped, highlights: ['Built the matcher.', 'Deployed on EKS.'] }],
            keyAchievements: [],
            sectionOrder:    ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
        } as unknown as StructuredResumeData;

        // Simulates a guard/condense pass rewriting the description (the
        // retired three-beat recipe's failure mode -- blending pitch with
        // bullet-duplicating prose) while ALSO legitimately trimming a
        // highlight -- the lock is field-scoped, so the description revert
        // must not undo the highlight trim.
        const guardCondensed: StructuredResumeData = {
            ...resume,
            projects: [{ name: 'Tucaken', description: `${stamped} Built the matcher end to end for every user.`, highlights: ['Built the matcher.'] }],
        } as unknown as StructuredResumeData;

        const restoredPasses: string[] = [];
        const out = await withProjectsDescriptionLock(resume, 'guard', async () => guardCondensed, (pass) => restoredPasses.push(pass));

        expect(out.projects[0]!.description).toBe(stamped);
        expect(out.projects[0]!.highlights).toEqual(['Built the matcher.']);
        expect(restoredPasses).toEqual(['guard']);
    });
});

// Task 5 (f): lane-mix coverage symmetry -- `scoreProjectsCoverage`
// (projects-ats-flow.ts, delegating to `experienceTermMatch` via
// `scoreExperienceCoverage`) must credit whichever lane actually carries the
// JD-relevant fact, not privilege curated over composed or vice versa.
describe('Task 5 (f): lane-mix -- JD-relevant curated beats off-JD composed, and vice versa', () => {
    it('credits the CURATED lane when the composed highlight is genuinely off-JD', () => {
        const coverage = scoreProjectsCoverage(LANE_MIX_CURATED_WINS.output, LANE_MIX_CURATED_WINS.pool, LANE_MIX_TARGETS);
        expect(coverage.covered).toBe(1);
        expect(coverage.missing).toEqual([]);
    });

    it('credits the COMPOSED lane when the curated highlight is genuinely off-JD (vice versa)', () => {
        const coverage = scoreProjectsCoverage(LANE_MIX_COMPOSED_WINS.output, LANE_MIX_COMPOSED_WINS.pool, LANE_MIX_TARGETS);
        expect(coverage.covered).toBe(1);
        expect(coverage.missing).toEqual([]);
    });
});

// G1 (run 976403b3): the projects agent emitted `entries` as a stringified
// JSON array of the well-formed GOLDEN_OUTPUT entries -- normalise-then-
// validate must parse it, substitute the real array, and continue into the
// normal per-item normalisation (the entry's model-authored description is
// still discarded per the C4 decision), landing on an output that parses
// cleanly and assembles byte-identical to the pool.
describe('G1: stringified-entries live failure (run 976403b3) is accepted end to end', () => {
    it('parses the stringified array, normalises per-item, and assembles cleanly', () => {
        const { output, normalisedExtras } = normaliseProjectsAgentOutput(STRINGIFIED_ENTRIES_RAW_PAYLOAD);

        // +1 for the string->array parse-substitute, +1 per entry for its
        // agent-authored description (both GOLDEN_OUTPUT entries carry one,
        // discarded per the C4 decision) -- 3 total; highlights are already
        // clean shapes so no further per-item extras are stripped.
        expect(normalisedExtras).toBe(3);

        const parsed = ProjectsAgentOutputSchema.parse(output);
        const assembled = assembleProjects(parsed, GOLDEN_TWO_LANE.pool);
        expect(assembled[0]!.highlights[0]).toBe('Wrote the RLS policies for multi-tenant Kubernetes clusters');
        expect(assembled[0]!.highlights[1]).toBe('Instrumented PostgreSQL row-level security across every write path');
        expect(assembled[1]!.highlights[0]).toBe('Automated CI checks across every workspace');
    });
});

// Task 5 (g): an entry with ALL SIX slots composed (zero curated), exactly
// at PROJECTS_MAX_BULLETS_PER_ENTRY, passes every grader -- Task 3's
// lane-mix contract allows a project to be entirely repo-current evidence,
// not just "curated plus up to two composed".
describe('Task 5 (g): a composed-uncapped entry (all composed, at the cap) is provenance-valid', () => {
    it('passes every grader, including provenance and composition', () => {
        const r = runProjectsGraders(ALL_COMPOSED_UNCAPPED);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });
});
