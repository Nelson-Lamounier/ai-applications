/** @format */
import type { ProjectEvidenceInput } from './skill-transfer-types.js';
import type {
  SystemDesignConcern, ConcernCoverage, DetectedConcern, ConcernEvidenceRef, ConcernStrength,
} from './system-design-concerns-types.js';

// Local tokenizer — intentionally does NOT strip 'system'/'design' (unlike skill-transfer's),
// since those are meaningful here. Lowercase alphanumeric tokens length >= 3.
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

type Hit = { ref: ConcernEvidenceRef; tier: 'strong' | 'weak' };

/** A row source: the rows, the text fields to match, how to build a ref, and the tier. */
interface HitSource<T> {
  rows: readonly T[];
  texts: (r: T) => string[];
  ref: (r: T) => ConcernEvidenceRef;
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

function hitsFor(concern: SystemDesignConcern, ev: ProjectEvidenceInput): Hit[] {
  const sig = signalTokens(concern.detectionSignals);
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

function strengthOf(hits: Hit[]): ConcernStrength {
  if (hits.some(h => h.tier === 'strong')) return 'strong';
  return hits.length > 0 ? 'partial' : 'none';
}

function isRelevant(concern: SystemDesignConcern, jdTokens: Set<string>): boolean {
  if (jdTokens.size === 0) return true;
  return signalTokens(concern.jdSignalKeywords).size === 0
    ? true
    : [...signalTokens(concern.jdSignalKeywords)].some(t => jdTokens.has(t));
}

/**
 * Deterministically detect which concerns the project addresses and how strongly.
 * Pure: evidence refs come only from real project rows, so the result is grounded
 * by construction. `jdText` filters/flags relevance (empty → all relevant).
 */
export function detectConcernEvidence(
  concerns: readonly SystemDesignConcern[],
  evidence: ProjectEvidenceInput,
  jdText: string,
): ConcernCoverage {
  const jdTokens = tok(jdText);
  const detected: DetectedConcern[] = concerns.map((concern) => {
    const hits = hitsFor(concern, evidence);
    return {
      concernId: concern.concernId,
      category: concern.category,
      strength: strengthOf(hits),
      evidenceRefs: hits.map(h => h.ref),
      relevantToJd: isRelevant(concern, jdTokens),
    };
  });
  const relevant = detected.filter(d => d.relevantToJd);
  return {
    detected,
    relevantTotal: relevant.length,
    relevantAddressed: relevant.filter(d => d.strength !== 'none').length,
  };
}
