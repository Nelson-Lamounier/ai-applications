/**
 * @format
 * Bar Raiser grounding spine.
 *
 * Mirrors the System Design grounding path in `@bedrock/shared`:
 *   - `detectPrincipleEvidence`     ↔ `detectConcernEvidence` (concern-detection.ts)
 *   - `buildBarRaiserBlock`         ↔ `buildConcernWalkthroughBlock` (coach-agent.ts)
 *   - `validateBarRaiserWalkthrough`↔ `validateSystemDesignWalkthrough` (system-design-walkthrough.ts)
 *
 * Deterministic detection maps a user's real project evidence
 * (`ProjectEvidenceInput`, the SAME shape the system-design path loads) to
 * leadership principles by signal-keyword/token overlap. Evidence refs come
 * only from real rows, so the result is grounded by construction. The validator
 * is the anti-invention backstop: any model story citing an id not detected for
 * its principle is dropped; a card left with no grounded stories is demoted to
 * an honest gap. No invented story survives.
 */
import type {
  ProjectEvidenceInput,
  PrincipleCoverageStrength,
  BarRaiserEvidenceRef,
  PrincipleCoverage,
  BarRaiserPrinciple,
} from '@bedrock/shared';
import type { LeadershipPrinciple } from './leadership-principles-repository.js';

// =============================================================================
// TYPES
// =============================================================================
// The detection-side shapes now live in `@bedrock/shared`
// (stage-prep/bar-raiser-types.ts) as the single source of truth, so the
// InterviewCoachResult schema in shared and this detection lib agree by
// construction. Re-exported here for the existing import sites + tests.

export type {
  PrincipleCoverageStrength,
  BarRaiserEvidenceRef,
  BarRaiserStory,
  BarRaiserProbingQuestion,
  PrincipleCoverage,
  BarRaiserPrinciple,
} from '@bedrock/shared';

/** Local detection-side alias for the shared coverage-strength union. */
type Coverage = PrincipleCoverageStrength;
/** Local detection-side alias for the shared evidence ref. */
type EvidenceRef = BarRaiserEvidenceRef;

// =============================================================================
// TOKENIZER + HIT COLLECTION (mirrors concern-detection.ts)
// =============================================================================

/** Lowercase alphanumeric tokens, length >= 3. */
function tok(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) out.add(t);
  return out;
}
function signalTokens(signals: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const sig of signals) for (const t of tok(sig)) out.add(t);
  return out;
}
function overlaps(sig: Set<string>, label: string): boolean {
  for (const t of tok(label)) if (sig.has(t)) return true;
  return false;
}

type Hit = { ref: EvidenceRef; tier: 'strong' | 'weak' };

interface HitSource<T> {
  rows: readonly T[];
  texts: (r: T) => string[];
  ref: (r: T) => EvidenceRef;
  tier: 'strong' | 'weak';
}

/** Collect hits from one source — a row matches when any of its texts overlaps the signal. */
function collectHits<T>(sig: Set<string>, src: HitSource<T>): Hit[] {
  const hits: Hit[] = [];
  for (const r of src.rows) {
    if (src.texts(r).some(t => overlaps(sig, t))) hits.push({ ref: src.ref(r), tier: src.tier });
  }
  return hits;
}

function hitsFor(principle: LeadershipPrinciple, ev: ProjectEvidenceInput): Hit[] {
  const sig = signalTokens(principle.signalKeywords);
  if (sig.size === 0) return [];
  // Tier by source: component/decision = demonstrated (strong); stack/tag/repo = claimed/declared (weak).
  return [
    collectHits(sig, { rows: ev.components, texts: c => [c.name], ref: c => ({ source: 'component', id: c.id, label: c.name }), tier: 'strong' }),
    collectHits(sig, { rows: ev.decisions, texts: d => (d.decision != null ? [d.title, d.decision] : [d.title]), ref: d => ({ source: 'decision', id: d.id, label: d.title }), tier: 'strong' }),
    collectHits(sig, { rows: ev.stackItems, texts: s => [s.name], ref: s => ({ source: 'stack_item', id: s.id, label: s.name }), tier: 'weak' }),
    collectHits(sig, { rows: ev.tags, texts: t => [t.tag], ref: t => ({ source: 'tag', id: `${t.projectId}:${t.tag}`, label: t.tag }), tier: 'weak' }),
    collectHits(sig, { rows: ev.repoEvidence, texts: e => [e.rawName], ref: e => ({ source: e.source, id: e.id, label: e.rawName, fileLine: e.fileLine }), tier: 'weak' }),
  ].flat();
}

function strengthOf(hits: Hit[]): Coverage {
  if (hits.some(h => h.tier === 'strong')) return 'strong';
  return hits.length > 0 ? 'partial' : 'none';
}

function isRelevant(principle: LeadershipPrinciple, jdTokens: Set<string>): boolean {
  if (jdTokens.size === 0) return true;
  const sig = signalTokens(principle.signalKeywords);
  return sig.size === 0 ? true : [...sig].some(t => jdTokens.has(t));
}

// =============================================================================
// 1. DETECT — principle → grounded project evidence
// =============================================================================

/**
 * Deterministically map project evidence to leadership principles. Pure: evidence
 * refs come only from real project rows, so the result is grounded by construction.
 * `jdText` flags relevance (empty → all relevant). Mirrors detectConcernEvidence.
 */
export function detectPrincipleEvidence(
  principles: readonly LeadershipPrinciple[],
  evidence: ProjectEvidenceInput,
  jdText: string,
): PrincipleCoverage[] {
  const jdTokens = tok(jdText);
  return principles.map((principle) => {
    const hits = hitsFor(principle, evidence);
    return {
      principleId: principle.principleId,
      coverage: strengthOf(hits),
      evidenceRefs: hits.map(h => h.ref),
      relevantToJd: isRelevant(principle, jdTokens),
    };
  });
}

// =============================================================================
// 2. BUILD BLOCK — render detected principles + grounded evidence for the prompt
// =============================================================================

/** Append the lines for a single principle (kept separate for complexity). */
function appendPrincipleLines(
  lines: string[],
  d: PrincipleCoverage,
  p: LeadershipPrinciple,
): void {
  lines.push(`- [${d.coverage}] ${p.principleId}: ${p.name}`);
  lines.push(`    interpretation: ${p.interpretation}`);
  if (d.evidenceRefs.length > 0) {
    for (const r of d.evidenceRefs) {
      lines.push(`    evidence: source=${r.source} id=${r.id} :: ${r.label}${r.fileLine ? ` @${r.fileLine}` : ''}`);
    }
  } else {
    lines.push('    evidence: (none — emit an honest gap card: coverage="none", stories=[], gapGuidance set)');
  }
  for (const s of p.storyShapes) lines.push(`    story-shape: ${s}`);
  for (const q of p.probingPatterns) lines.push(`    probing: ${q}`);
}

/**
 * Render relevant principles + their grounded evidence as a block the model must
 * cite from. Mirrors buildConcernWalkthroughBlock. Empty when nothing is relevant.
 */
export function buildBarRaiserBlock(
  coverage: readonly PrincipleCoverage[],
  principles: readonly LeadershipPrinciple[],
): string {
  const byId = new Map(principles.map(p => [p.principleId, p]));
  const relevant = coverage.filter(d => d.relevantToJd);
  if (relevant.length === 0) return '';
  const lines = ['## Leadership principles for THIS role (emit one card per principle, cite ONLY these evidence ids)'];
  for (const d of relevant) {
    const p = byId.get(d.principleId);
    if (!p) continue;
    appendPrincipleLines(lines, d, p);
  }
  lines.push(
    'For EACH principle: build STAR stories that cite ONLY the evidence ids listed for it. Write in ' +
    'first person, name the trade-off and what you learned. Calibrate honesty (demonstrated > declared ' +
    '> claimed) and note the seniority signal. Never invent evidence or claim scale not shown. ' +
    'No evidence → honest gap card (coverage="none", stories=[], gapGuidance set).',
  );
  return lines.join('\n');
}

// =============================================================================
// 3. VALIDATE — anti-invention backstop
// =============================================================================

const GAP_GUIDANCE =
  'Your projects show no grounded evidence for this principle yet. Be honest: describe how you ' +
  'would demonstrate it and bridge from the nearest real work you did.';

function toGapCard(card: BarRaiserPrinciple): BarRaiserPrinciple {
  return {
    principleId: card.principleId,
    principleName: card.principleName,
    interpretation: card.interpretation,
    coverage: 'none',
    stories: [],
    probingQuestions: card.probingQuestions,
    gapGuidance: card.gapGuidance ?? GAP_GUIDANCE,
  };
}

/**
 * Sanitise coach-emitted principle cards against the deterministic detection.
 * Unknown principle → dropped. Each story must cite ONLY ids detected for its
 * principle; ungrounded stories are dropped. A card left with no grounded stories
 * is demoted to an honest gap. Mirrors validateSystemDesignWalkthrough.
 */
export function validateBarRaiserWalkthrough(
  cards: readonly BarRaiserPrinciple[],
  coverage: readonly PrincipleCoverage[],
): BarRaiserPrinciple[] {
  const refsByPrinciple = new Map(
    coverage.map(d => [d.principleId, new Set(d.evidenceRefs.map(r => r.id))]),
  );
  const out: BarRaiserPrinciple[] = [];
  for (const card of cards) {
    const allowed = refsByPrinciple.get(card.principleId);
    if (!allowed) continue; // unknown principle → drop
    const grounded = card.stories.filter(
      s => s.evidenceRefs.length > 0 && s.evidenceRefs.every(r => allowed.has(r.id)),
    );
    out.push(grounded.length === 0 ? toGapCard(card) : { ...card, stories: grounded });
  }
  return out;
}
