/**
 * @format
 * tech_stack reconciliation (WS3 of the profile-LLM hardening).
 *
 * profile-extract LLM-guesses a tech_stack from a 30-commit snapshot; the
 * tech-extractor independently produces file-cited technology_evidence (SBOM-grade
 * ground truth). They diverge and never reconcile. This runs in the tech-extractor
 * — the only point THIS run's technology_evidence exists — and writes the
 * evidence-backed verified stack + a divergence record onto the profile, WITHOUT
 * destroying the LLM list (consumers prefer `tech_stack_verified`). Mirrors the
 * resume<->GitHub reconciliation pattern: claims with no evidence are surfaced,
 * not silently kept.
 */
import type { Pool } from 'pg';

export interface TechReconciliation {
    /** Evidence-backed tech (display names) — file-cited ground truth. */
    readonly reconciled: string[];
    /** Profile-claimed tech with NO file evidence (unverified / possibly invented). */
    readonly llmOnly: string[];
    /** Evidenced tech the LLM missed. */
    readonly evidenceOnly: string[];
}

interface EvidenceTech { readonly canonical: string; readonly display: string }

/**
 * Pure set-diff. `evidence` is the file-cited canonical tech (lowercased canonical
 * + display); `profile` is the LLM's raw tech_stack strings; `aliasToCanonical`
 * maps any lowercased alias/canonical to its canonical_name (the ontology). A
 * profile term counts as verified only if it resolves to a canonical that has
 * evidence; everything else is llmOnly.
 */
/**
 * Normalise an LLM tech name toward its canonical form so version-tagged /
 * qualified product names match file-cited evidence: strips a trailing version
 * ("React 19" -> "react", "Tailwind CSS 4" -> "tailwind css", "v2") and a
 * parenthetical qualifier ("Redis (ioredis)" -> "redis"). The leading-space guard
 * on the version regex protects names that legitimately end in digits (s3, ec2,
 * log4j). Without this the divergence over-reports same-tech-different-granularity
 * as unbacked claims.
 */
export function normalizeTechName(s: string): string {
    return s.toLowerCase().trim()
        .replace(/\s*\([^)]*\)/g, '')        // drop "(ioredis)"
        .replace(/\s+v?\d+(\.\d+)*$/, '')      // drop trailing " 19" / " 4.1" / " v2"
        .replace(/\s+/g, ' ').trim();
}

/** Map one key to an evidenced canonical (alias-hit or self-canonical), else null. */
function lookupCanon(
    key: string, aliasToCanonical: ReadonlyMap<string, string>, evByCanon: ReadonlyMap<string, string>,
): string | null {
    const c = aliasToCanonical.get(key) ?? (evByCanon.has(key) ? key : null);
    return c && evByCanon.has(c) ? c : null;
}

/** Resolve a profile term to an evidenced canonical, trying the raw key then the normalised form. */
function resolveProfileTerm(
    key: string, aliasToCanonical: ReadonlyMap<string, string>, evByCanon: ReadonlyMap<string, string>,
): string | null {
    const direct = lookupCanon(key, aliasToCanonical, evByCanon);
    if (direct) return direct;
    const norm = normalizeTechName(key);
    return norm === key ? null : lookupCanon(norm, aliasToCanonical, evByCanon);
}

export function diffTechSets(
    evidence: readonly EvidenceTech[],
    profile: readonly string[],
    aliasToCanonical: ReadonlyMap<string, string>,
): TechReconciliation {
    const evByCanon = new Map<string, string>();          // canonical -> display
    for (const e of evidence) evByCanon.set(e.canonical, e.display);

    const profileCanon = new Set<string>();
    const llmOnly: string[] = [];
    const seenLlm = new Set<string>();
    for (const raw of profile) {
        if (typeof raw !== 'string') continue;
        const key = raw.trim().toLowerCase();
        if (!key) continue;
        const canon = resolveProfileTerm(key, aliasToCanonical, evByCanon);
        if (canon) {
            profileCanon.add(canon);                       // verified by evidence
        } else if (!seenLlm.has(key)) {
            seenLlm.add(key);
            llmOnly.push(raw.trim());                      // claimed, no file evidence
        }
    }

    const cmp = (a: string, b: string) => a.localeCompare(b);
    const reconciled   = [...evByCanon.values()].sort(cmp);
    const evidenceOnly = [...evByCanon.entries()]
        .filter(([canon]) => !profileCanon.has(canon))
        .map(([, display]) => display)
        .sort(cmp);

    return { reconciled, llmOnly: llmOnly.sort(cmp), evidenceOnly };
}

/**
 * Reconcile the profile's LLM tech_stack against this repo's technology_evidence
 * and persist the result onto repository_profiles.extracted (verified stack +
 * divergence). No-op when there is no profile row or no evidence yet. Cheap:
 * three SELECTs + one UPDATE. Best-effort — the caller swallows failures.
 */
export async function reconcileTechStack(
    pool: Pool,
    userId: string,
    repoFullName: string,
): Promise<TechReconciliation | null> {
    const evidence = await pool.query<EvidenceTech>(
        `SELECT DISTINCT lower(t.canonical_name) AS canonical, t.display_name AS display
           FROM technology_evidence te
           JOIN technology_ontology t ON t.id = te.technology_id
          WHERE te.user_id = $1::uuid AND te.repo_full_name = $2 AND te.technology_id IS NOT NULL`,
        [userId, repoFullName],
    );
    if (evidence.rows.length === 0) return null;            // nothing to reconcile against

    const profileRes = await pool.query<{ tech: string[] | null }>(
        `SELECT extracted->'tech_stack' AS tech FROM repository_profiles
          WHERE user_id = $1::uuid AND repo_full_name = $2`,
        [userId, repoFullName],
    );
    if (profileRes.rows.length === 0) return null;          // no profile to write onto
    const profile = Array.isArray(profileRes.rows[0]?.tech) ? profileRes.rows[0].tech : [];

    const aliasRes = await pool.query<{ k: string; v: string }>(
        `SELECT lower(canonical_name) AS k, canonical_name AS v FROM technology_ontology
         UNION
         SELECT lower(a.alias) AS k, t.canonical_name AS v
           FROM technology_aliases a JOIN technology_ontology t ON t.id = a.technology_id`,
    );
    const aliasToCanonical = new Map<string, string>();
    for (const r of aliasRes.rows) aliasToCanonical.set(r.k, r.v.toLowerCase());

    const result = diffTechSets(evidence.rows, profile, aliasToCanonical);

    await pool.query(
        `UPDATE repository_profiles
            SET extracted = jsonb_set(
                  jsonb_set(extracted, '{tech_stack_verified}', $3::jsonb, true),
                  '{tech_divergence}', $4::jsonb, true),
                updated_at = now()
          WHERE user_id = $1::uuid AND repo_full_name = $2 AND extracted IS NOT NULL`,
        [
            userId,
            repoFullName,
            JSON.stringify(result.reconciled),
            JSON.stringify({ llmOnly: result.llmOnly, evidenceOnly: result.evidenceOnly }),
        ],
    );

    return result;
}
