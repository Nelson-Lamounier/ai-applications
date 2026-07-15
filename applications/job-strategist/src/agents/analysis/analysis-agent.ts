/**
 * @format
 * Strategist Analysis Agent -- dedicated Sonnet call producing the Phase 0
 * archetype selection and the Phase 1-3 narrative (JD analysis, gap
 * analysis, fit rating, gap mitigations, and a go/no-go recommendation).
 * The writer's genuinely-LLM remainder after the resume/cover-letter/
 * experience/projects/skills passes were split into dedicated agents
 * (Phase 5 PR-B) -- the one deliberative task left, so it keeps extended
 * thinking, at ~4x below the old writer's budget.
 *
 * `analysisXml` is LOAD-BEARING: run-pipeline's semantic cache-hit gate
 * requires a non-empty string, so `parseAnalysisResponse` throws rather than
 * silently returning an empty/blank analysis.
 */
import {
    runAgent,
    OutputSanitiser,
    type AgentConfig,
    type AgentName,
    type AgentResult,
    type StrategistAnalysisResult,
    type StrategistPipelineContext,
} from '@bedrock/shared';
import { STRATEGIST_ANALYSIS_META, STRATEGIST_ANALYSIS_SYSTEM_PROMPT } from '../../prompts/strategist-analysis.js';
import { buildAnalysisMessage, type AnalysisMessageInput } from './analysis-message.js';
import { extractArchetypeSelection, extractGapMitigations, extractMetadataFromXml } from './analysis-extractors.js';

/** Sonnet by default -- nuanced multi-section structured output; never Haiku. */
const ANALYSIS_MODEL = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env['INFERENCE_PROFILE_ARN'] ?? ANALYSIS_MODEL;

/** Module-scoped output sanitiser (default patterns -- redacts infrastructure identifiers). */
const outputSanitiser = new OutputSanitiser();

/**
 * Agent configuration for the Strategist Analysis Agent.
 *
 * Extended thinking stays on (thinkingBudget 2048) -- archetype selection +
 * fit-rating + gap-mitigation reasoning is the one genuinely deliberative
 * task left after the section-agent split, but at ~4x below the old
 * writer's 8192-token budget (structured output, not full document
 * generation). No tool -- this is a narrative XML text response, matching
 * the pre-split writer's output contract minus the resume/cover-letter
 * sections.
 *
 * `agentName: 'strategist-analysis'` is cast below -- the AgentName union
 * does not yet include it (Task 6 adds it).
 */
const ANALYSIS_CONFIG: AgentConfig = {
    agentName: 'strategist-analysis' as AgentName, // Task 6 adds these to the union
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: 8000,
    thinkingBudget: 2048,
    systemPrompt: STRATEGIST_ANALYSIS_SYSTEM_PROMPT,
    pipeline: 'job-strategist',
    promptId: STRATEGIST_ANALYSIS_META.id,
    promptVersion: STRATEGIST_ANALYSIS_META.version,
};

/**
 * Parse the raw XML response into a StrategistAnalysisResult.
 *
 * Sanitises output (redacts infrastructure identifiers) the same way the
 * pre-split writer did, then extracts metadata, gap mitigations, and the
 * Phase 0 archetype selection. `coverLetter`/`tailoredResumeData` are null
 * and the deprecated resume-suggestion fields are stubbed -- those are owned
 * by dedicated passes downstream, not by this agent.
 *
 * @param text - Raw text response from Bedrock
 * @throws when the sanitised XML is empty/blank -- load-bearing: the
 *         run-pipeline semantic cache-hit gate requires a non-empty string,
 *         so a blank analysis must fail the run rather than cache silently.
 */
export function parseAnalysisResponse(text: string): StrategistAnalysisResult {
    const sanitised = outputSanitiser.sanitise(text);
    if (!sanitised.trim()) {
        throw new Error('strategist-analysis: empty analysisXml -- cannot produce a cache-eligible analysis result');
    }

    return {
        analysisXml: sanitised,
        metadata: extractMetadataFromXml(sanitised),
        gapMitigations: extractGapMitigations(sanitised),
        coverLetter: null,
        archetypeSelection: extractArchetypeSelection(sanitised),
        tailoredResumeData: null,
        resumeSuggestions: { additions: [], reframes: [], eslCorrections: [] },
        resumeAdditions: 0,
        resumeReframes: 0,
        eslCorrections: 0,
    };
}

/**
 * Execute the Strategist Analysis Agent.
 *
 * @param ctx   - Pipeline context (token/cost accumulation)
 * @param input - Analysis-agent input (research brief, code stack, years-gap
 *                framing, profile intelligence)
 * @returns The Phase 0 archetype selection + Phase 1-3 narrative XML
 */
export async function executeAnalysisAgent(
    ctx: StrategistPipelineContext,
    input: AnalysisMessageInput,
): Promise<AgentResult<StrategistAnalysisResult>> {
    return runAgent<StrategistAnalysisResult>({
        config: ANALYSIS_CONFIG,
        userMessage: buildAnalysisMessage(input),
        parseResponse: (responseText) => parseAnalysisResponse(responseText),
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });
}
