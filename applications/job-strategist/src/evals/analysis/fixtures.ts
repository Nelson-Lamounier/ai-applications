/**
 * @format
 * Synthetic analysis-agent eval fixtures - no Bedrock, no PII.
 *
 * GOLDEN_ANALYSIS is built by running a realistic fixture XML through the
 * REAL `parseAnalysisResponse` (same fixture style as
 * `agents/analysis/__tests__/analysis-agent.test.ts`) so the golden result is
 * tautologically what the production parser produces, not a hand-built
 * StrategistAnalysisResult that could drift from the parser's actual shape.
 *
 * `extractArchetypeSelection` and `extractMetadataFromXml` already CLAMP an
 * out-of-range archetype_id (falls back to 1) and an invalid fit-rating tag
 * (falls back to 'STRETCH') -- so an adversarial XML can never reach the
 * grader with a genuinely invalid value. The archetype-id and fit-rating
 * adversarials below therefore construct the invalid StrategistAnalysisResult
 * directly (spread + override), the same way the experience/projects fixture
 * adversarials mutate a parsed golden output rather than re-deriving one.
 */
import type { ArchetypeId, FitRating } from '@bedrock/shared';
import { parseAnalysisResponse } from '../../agents/analysis/analysis-agent.js';
import type { AnalysisEvalInput } from './analysis-graders.js';

const RESEARCH_GAPS = ['Ansible', 'Terraform'];

const GOLDEN_XML = `
<job_application_analysis>
  <phase_0_archetype_selection>
    <selected_archetype>Site Reliability Engineer (SRE)</selected_archetype>
    <archetype_id>2</archetype_id>
    <trigger_phrases_matched>
      <phrase>on-call</phrase>
      <phrase>MTTR</phrase>
    </trigger_phrases_matched>
    <excluded_content_categories>
      <category>frontend frameworks</category>
    </excluded_content_categories>
    <lead_identity><![CDATA[SRE focused on reliability and incident response.]]></lead_identity>
    <confidence_score>0.9</confidence_score>
    <archetype_gap_detected>false</archetype_gap_detected>
  </phase_0_archetype_selection>
  <metadata>
    <candidate_name>Jane Doe</candidate_name>
    <target_role>Site Reliability Engineer</target_role>
    <target_company>Acme Corp</target_company>
    <analysis_date>2026-07-15</analysis_date>
    <overall_fit_rating>STRONG FIT</overall_fit_rating>
    <application_recommendation>APPLY</application_recommendation>
  </metadata>
  <phase_3_strategy>
    <gap_mitigation>
      <mitigation><gap>Ansible</gap><honest_framing>No Ansible experience; config management achieved via AWS CDK TypeScript</honest_framing><bridge_narrative>Declarative infrastructure automation daily, different tool</bridge_narrative><proactive_action>Work through an Ansible playbook conversion</proactive_action><go_no_go>go</go_no_go></mitigation>
    </gap_mitigation>
  </phase_3_strategy>
</job_application_analysis>
`;

/**
 * Passes every grader: archetypeId 2 is a valid integer in 1-7 with
 * non-empty selectedArchetype/leadIdentity; the sole gap mitigation names
 * "Ansible", which IS in RESEARCH_GAPS; overallFitRating is 'STRONG FIT', a
 * valid FitRating.
 */
export const GOLDEN_ANALYSIS: AnalysisEvalInput = {
    result: parseAnalysisResponse(GOLDEN_XML),
    researchGaps: RESEARCH_GAPS,
};

/**
 * Adversarial: archetypeId set to 9 (out of the 1-7 range) directly on the
 * parsed result -- trips ONLY archetypeValidGrader; gap mitigations and
 * metadata are untouched.
 */
export const ADVERSARIAL_ARCHETYPE_INVALID: AnalysisEvalInput = {
    ...GOLDEN_ANALYSIS,
    result: {
        ...GOLDEN_ANALYSIS.result,
        archetypeSelection: {
            ...GOLDEN_ANALYSIS.result.archetypeSelection!,
            archetypeId: 9 as unknown as ArchetypeId,
        },
    },
};

/**
 * Adversarial: the mitigation's gap is renamed to "Kubernetes", which is NOT
 * in RESEARCH_GAPS -- trips ONLY noGapFabricationGrader; archetype selection
 * and metadata are untouched.
 */
export const ADVERSARIAL_GAP_FABRICATION: AnalysisEvalInput = {
    ...GOLDEN_ANALYSIS,
    result: {
        ...GOLDEN_ANALYSIS.result,
        gapMitigations: GOLDEN_ANALYSIS.result.gapMitigations.map((m) => ({ ...m, gap: 'Kubernetes' })),
    },
};

/**
 * Adversarial: overallFitRating overridden to a bogus value that could never
 * survive `FitRatingSchema.catch(...)` in real parsing -- trips ONLY
 * fitRatingGrader; archetype selection and gap mitigations are untouched.
 */
export const ADVERSARIAL_BOGUS_RATING: AnalysisEvalInput = {
    ...GOLDEN_ANALYSIS,
    result: {
        ...GOLDEN_ANALYSIS.result,
        metadata: {
            ...GOLDEN_ANALYSIS.result.metadata,
            overallFitRating: 'AMAZING FIT' as unknown as FitRating,
        },
    },
};
