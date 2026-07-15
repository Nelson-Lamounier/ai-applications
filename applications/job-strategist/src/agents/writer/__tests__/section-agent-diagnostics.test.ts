/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import type { StrategistAnalysisResult } from '@bedrock/shared';
import {
  logSectionAgentEvents,
  skillsAgentOutcome,
  skillsAgentEvents,
  coverLetterAgentOutcome,
  coverLetterAgentEvents,
  analysisAgentSummary,
  analysisAgentEvents,
  type SectionAgentLogKeys,
  type SkillsAgentDiagnostics,
  type CoverLetterAgentResult,
} from '../section-agent-diagnostics.js';

const keys: SectionAgentLogKeys = { pipelineRunId: 'pr1', applicationId: 'app1', traceId: 'tr1' };

describe('logSectionAgentEvents', () => {
  it('namespaces each event by agentKey and stamps correlation keys on every line', () => {
    const info = jest.fn();
    logSectionAgentEvents({ info } as never, keys, 'skills_agent', [
      { suffix: 'scored', data: { categories: 3, items: 10 } },
      { suffix: 'fallback' },
    ]);
    expect(info).toHaveBeenCalledTimes(2);
    const [scoredCall, fallbackCall] = info.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(scoredCall['event']).toBe('skills_agent_scored');
    expect(scoredCall['categories']).toBe(3);
    expect(scoredCall['items']).toBe(10);
    expect(fallbackCall['event']).toBe('skills_agent_fallback');
    for (const c of info.mock.calls) {
      const o = c[0] as Record<string, unknown>;
      expect(o['pipeline_run_id']).toBe('pr1');
      expect(o['application_id']).toBe('app1');
      expect(o['trace_id']).toBe('tr1');
    }
  });

  it('emits nothing when the events list is empty', () => {
    const info = jest.fn();
    logSectionAgentEvents({ info } as never, keys, 'analysis_agent', []);
    expect(info).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Skills agent
// ---------------------------------------------------------------------------

const agentDiag: SkillsAgentDiagnostics = { outcome: 'agent', violations: [], categories: 3, items: 12 };

describe('skillsAgentOutcome', () => {
  it('maps an agent success to {outcome: agent, reason: ok}', () => {
    expect(skillsAgentOutcome(agentDiag)).toEqual({ outcome: 'agent', reason: 'ok' });
  });

  it('maps a ledger-membership violation to {outcome: fallback, reason: membership-invalid}', () => {
    const diag: SkillsAgentDiagnostics = { outcome: 'fallback', violations: ['unknown_skill:Kubernetes'], categories: 2, items: 6 };
    expect(skillsAgentOutcome(diag)).toEqual({ outcome: 'fallback', reason: 'membership-invalid' });
  });

  it('maps a category/item cap violation to {outcome: fallback, reason: caps}', () => {
    const diag: SkillsAgentDiagnostics = { outcome: 'fallback', violations: ['category_cap:6'], categories: 6, items: 6 };
    expect(skillsAgentOutcome(diag)).toEqual({ outcome: 'fallback', reason: 'caps' });
  });

  it('maps a fallback with no violation tokens (raw agent-call error) to the fixed agent-error token', () => {
    const diag: SkillsAgentDiagnostics = { outcome: 'fallback', violations: [], categories: 1, items: 4 };
    expect(skillsAgentOutcome(diag)).toEqual({ outcome: 'fallback', reason: 'agent-error' });
  });
});

describe('skillsAgentEvents', () => {
  it('emits only scored when the agent succeeded cleanly', () => {
    expect(skillsAgentEvents(agentDiag)).toEqual([{ suffix: 'scored', data: { categories: 3, items: 12 } }]);
  });

  it('emits scored + membership_reject with the rejected tokens when membership was violated', () => {
    const diag: SkillsAgentDiagnostics = { outcome: 'fallback', violations: ['unknown_skill:Kubernetes', 'unknown_skill:Rust'], categories: 2, items: 6 };
    const events = skillsAgentEvents(diag);
    expect(events).toEqual(expect.arrayContaining([
      { suffix: 'scored', data: { categories: 2, items: 6 } },
      { suffix: 'membership_reject', data: { tokens: ['unknown_skill:Kubernetes', 'unknown_skill:Rust'] } },
      { suffix: 'fallback', data: { reason: 'membership-invalid' } },
    ]));
  });

  it('does not emit membership_reject when there are no unknown_skill tokens', () => {
    const diag: SkillsAgentDiagnostics = { outcome: 'fallback', violations: ['category_cap:6'], categories: 6, items: 6 };
    const suffixes = skillsAgentEvents(diag).map((e) => e.suffix);
    expect(suffixes).not.toContain('membership_reject');
  });

  it('does not emit fallback when the agent lane succeeded', () => {
    const suffixes = skillsAgentEvents(agentDiag).map((e) => e.suffix);
    expect(suffixes).not.toContain('fallback');
  });
});

// ---------------------------------------------------------------------------
// Cover-letter agent
// ---------------------------------------------------------------------------

describe('coverLetterAgentOutcome', () => {
  it('maps a successful requested letter to {outcome: agent, reason: ok}', () => {
    const res: CoverLetterAgentResult = { requested: true, failed: false };
    expect(coverLetterAgentOutcome(res)).toEqual({ outcome: 'agent', reason: 'ok' });
  });

  it('maps a failed requested letter to {outcome: omitted, reason: agent-error} -- never the raw error', () => {
    const res: CoverLetterAgentResult = { requested: true, failed: true };
    expect(coverLetterAgentOutcome(res)).toEqual({ outcome: 'omitted', reason: 'agent-error' });
  });

  it('maps an unrequested letter to {outcome: omitted, reason: not-requested}', () => {
    const res: CoverLetterAgentResult = { requested: false, failed: false };
    expect(coverLetterAgentOutcome(res)).toEqual({ outcome: 'omitted', reason: 'not-requested' });
  });
});

describe('coverLetterAgentEvents', () => {
  it('emits only generated on success', () => {
    expect(coverLetterAgentEvents({ requested: true, failed: false })).toEqual([{ suffix: 'generated' }]);
  });

  it('emits only omitted with reason agent-error on failure', () => {
    expect(coverLetterAgentEvents({ requested: true, failed: true })).toEqual([{ suffix: 'omitted', data: { reason: 'agent-error' } }]);
  });

  it('emits only omitted with reason not-requested when not requested', () => {
    expect(coverLetterAgentEvents({ requested: false, failed: false })).toEqual([{ suffix: 'omitted', data: { reason: 'not-requested' } }]);
  });
});

// ---------------------------------------------------------------------------
// Analysis agent
// ---------------------------------------------------------------------------

function buildAnalysisData(overrides: Partial<StrategistAnalysisResult> = {}): StrategistAnalysisResult {
  return {
    analysisXml: '<analysis/>',
    metadata: {
      candidateName: 'Jane Doe',
      targetRole: 'SRE',
      targetCompany: 'Acme',
      analysisDate: '2026-07-10',
      overallFitRating: 'strong' as never,
      applicationRecommendation: 'apply' as never,
    },
    gapMitigations: [],
    coverLetter: null,
    archetypeSelection: null,
    tailoredResumeData: null,
    resumeSuggestions: { additions: [], reframes: [], eslCorrections: [] } as never,
    resumeAdditions: 0,
    resumeReframes: 0,
    eslCorrections: 0,
    ...overrides,
  };
}

describe('analysisAgentSummary', () => {
  it('returns null archetypeId/confidence when no archetype was selected', () => {
    expect(analysisAgentSummary(buildAnalysisData())).toEqual({ archetypeId: null, confidence: null, mitigations: 0 });
  });

  it('derives archetypeId/confidence from archetypeSelection and mitigations from gapMitigations length', () => {
    const data = buildAnalysisData({
      archetypeSelection: {
        selectedArchetype: 'SRE', archetypeId: 2 as never, triggerPhrasesMatched: [], excludedContentCategories: [],
        leadIdentity: 'Reliability engineer', confidenceScore: 0.92, archetypeGapDetected: false,
      },
      gapMitigations: [
        { gap: 'Terraform', honestFraming: 'f', bridgeNarrative: 'b', proactiveAction: 'p', goNoGo: 'go' },
      ],
    });
    expect(analysisAgentSummary(data)).toEqual({ archetypeId: 2, confidence: 0.92, mitigations: 1 });
  });
});

describe('analysisAgentEvents', () => {
  it('always emits archetype with lead_identity_present derived from archetypeSelection', () => {
    const data = buildAnalysisData({
      archetypeSelection: {
        selectedArchetype: 'SRE', archetypeId: 2 as never, triggerPhrasesMatched: [], excludedContentCategories: [],
        leadIdentity: 'Reliability engineer', confidenceScore: 0.92, archetypeGapDetected: false,
      },
    });
    expect(analysisAgentEvents(data)).toEqual([
      { suffix: 'archetype', data: { archetype_id: 2, confidence: 0.92, lead_identity_present: true } },
    ]);
  });

  it('reports lead_identity_present:false and no mitigations event when nothing to report', () => {
    const events = analysisAgentEvents(buildAnalysisData());
    expect(events).toEqual([
      { suffix: 'archetype', data: { archetype_id: null, confidence: null, lead_identity_present: false } },
    ]);
  });

  it('emits mitigations with the count when gap defences exist', () => {
    const data = buildAnalysisData({
      gapMitigations: [
        { gap: 'Terraform', honestFraming: 'f', bridgeNarrative: 'b', proactiveAction: 'p', goNoGo: 'go' },
        { gap: 'Rust', honestFraming: 'f', bridgeNarrative: 'b', proactiveAction: 'p', goNoGo: 'go' },
      ],
    });
    const events = analysisAgentEvents(data);
    expect(events).toEqual(expect.arrayContaining([{ suffix: 'mitigations', data: { count: 2 } }]));
  });
});
