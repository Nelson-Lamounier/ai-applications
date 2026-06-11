# Resume refactor — design

**Date:** 2026-06-11
**Status:** Approved (design) — pending plan
**Repo:** `ai-applications` (persona/constraints + resume guard + pipeline)
**Branch:** `feat/resume-refactor` (off `develop` — build AFTER #179 role-ontology / #180 years-gap / #181 cover-letter merge, so Archetype 7 + yearsGap framing + positioning headline are present).

## Problem (two-reader model)

The ATS scores keyword density + parseable structure; the human reads ~6-10s in an
F-pattern (name → title → first job's first line → dates → skills). A section dies if
it fails the keyword match OR sits where the eye doesn't land. The last resume failed
both:

- **Headline** "Technical Operations Engineer" parses as the current title → conflicts
  with the AWS employment title → mismatched-title flag / auto-deprioritise.
- **Summary** leads "Cloud infrastructure engineer with 3+ years…" — burns the
  highest-weighted real estate on the wrong keyword cluster for a support req, and
  hands over the years gap + wrong identity in the first two seconds.
  **Root cause:** `resume-constraints.ts` JD-signal quick-map literally instructs the
  support/TSE opener as *"Cloud infrastructure engineer with [N] years triaging…"*.
- **Skills** bury the matched terms (Python, troubleshooting, root cause) behind
  "Scripting & Operational Tooling" + infra jargon — found by the ATS, not rewarded.
- **Experience** bullets 3-5 go unread; the lead bullet must carry the role, but there's
  no rule to front-load the strongest number-led bullet.
- **Projects** — a dense standalone block (Calico CNI, etcd/PKI, CDK assertions) that a
  support manager's eye slides off; dead weight below the fold.
- **Education** surfaces "Digital Marketing" (older BA) instead of the relevant Computing
  HDip.

## Target (the rewrites — for ANY user/JD, archetype-driven)

1. **Headline = positioning headline** "`<target-aligned role> · <domain breadth>`"
   (e.g. "Technical Support Engineer · Cloud & AI Operations") — descriptive positioning,
   never an employment-title claim that conflicts. (Rule exists at
   `strategist-persona.ts`; this adds the deterministic guard.)
2. **Summary leads with the archetype `leadIdentity` differentiator** + a concrete
   number + the AI hook + the yearsGap relevant-experience framing — never the wrong
   keyword cluster, never the raw years gap.
3. **Skills** — the archetype's matched group leads (support → "Support &
   Troubleshooting"); within each group, JD-matched/required terms come first.
4. **Experience** — front-load the **strongest, number-led bullet** per role (the lead
   bullet carries; metric-first), then the rest by archetype priority.
5. **Projects** — when the archetype deprioritises projects, **collapse** the standalone
   block into one compact "Selected work: … github links" line, not a dense section.
6. **Education** — most-relevant degree leads, the older/less-relevant degree is
   de-emphasised (not its own emphasis block); degree names stay verbatim (already
   enforced — never rename).

## Part 1 — persona / constraints rules

`strategist-persona.ts` + `resume-constraints.ts`:

- **Summary quick-map fix** — replace the hardcoded *"Cloud infrastructure engineer…"*
  TSE/support opener with: open with the archetype `leadIdentity` differentiator (the
  same identity the resume + cover letter share), then the strongest number, then the
  AI/portfolio hook, then the cert. When a YEARS GAP FRAMING line is present, the opener
  reflects it (already wired) — never a single-role tenure that undersells.
- **Skills ordering** — generic (not archetype-6-only): (a) the leading skill group is
  the one matching the archetype's domain (support archetype → a "Support &
  Troubleshooting" group with escalation/root-cause/SaaS-troubleshooting/SLA terms);
  (b) within every group, list JD-matched/required terms first, infra jargon last.
- **Experience lead-bullet rule** — within each role, after archetype-category ordering,
  the FIRST bullet must be the one with the strongest concrete number/impact (metric-led),
  because only bullets 1-2 are read.
- **Projects collapse rule** — when the selected archetype's `excludedContentCategories`
  / priority deprioritises standalone projects (support/customer archetype), emit Projects
  as a single compact "Selected work" line under the relevant role (curated GitHub links,
  deduped against experience), NOT a standalone block. A builder archetype keeps the block.
- **Education ordering rule** — order education by relevance-then-recency (reverse-chron
  already floats the recent HDip up); do NOT give the older/less-relevant degree its own
  emphasis; keep degree names verbatim.
- **Archetype 7 enrichment** (now present from #179) — its `leadIdentity` =
  customer-facing support+AI ("Support engineer who builds production AI"), `sectionOrder`
  leads summary→experience with projects collapsed, skills-lead = "Support &
  Troubleshooting". (Confirm/411 adjust #179's Archetype-7 detail to match these targets.)

## Part 2 — deterministic resume guard + Haiku rewrite

New `applications/job-strategist/src/agents/resume-guard.ts` (mirrors `cover-letter-guard.ts`):

```ts
interface ResumeViolation { code: string; detail: string; }
/** Deterministic content checks on the structured resume. */
export function validateResume(resume: StructuredResumeData, ctx: {
  targetRole: string; leadIdentity: string; verifiedEducation: string[]; archetypeSkillLead: string;
}): ResumeViolation[];
```
Checks (each a `code`):
- `headline_is_title` — `profile.title` lacks a positioning separator ("·"/"—") OR equals
  a verbatim employment title from `experience[].title` (it's a job-title claim, not a
  positioning headline).
- `summary_wrong_cluster` — the summary's FIRST sentence does not contain the
  `leadIdentity` head noun (e.g. "support") and instead opens with a deprioritised cluster
  (e.g. "cloud infrastructure engineer" for a support archetype). Heuristic: first
  sentence must include a token from `leadIdentity`.
- `summary_names_gap` — the summary contains a raw-years-gap/self-deprecation phrase
  (reuse the cover-letter `names_gap` patterns) — the summary must not hand over the gap.
- `education_mismatch` — an `education[].degree` does not match any `verifiedEducation`
  string (catches a renamed/wrong-surfaced degree). (Verbatim-accuracy check.)
- `skills_lead_mismatch` — for an archetype with a required `archetypeSkillLead`, the
  FIRST `skills[].category` is not that group.

```ts
export async function rewriteResume(resume, violations, ctx): Promise<StructuredResumeData>; // Haiku, fail-open → input
export async function guardResume(resume, ctx): Promise<{ resume: StructuredResumeData; violations: ResumeViolation[] }>;
```
- `guardResume`: validate → if violations, a Haiku rewrite fixes ONLY the flagged issues
  (reorder/reword — never fabricate, never add a claim, keep all facts + education names
  verbatim) → return. Fail-open (never throws; rewrite error → original).

## Part 3 — wiring (`run-pipeline`)

After the strategist returns the tailored resume (and after the cover-letter guard):
```ts
const { resume: finalResume, violations: resumeViolations } = await guardResume(tailoredResumeData, {
  targetRole: research.data.targetRole,
  leadIdentity: analysis.data.archetypeSelection?.leadIdentity ?? '',
  verifiedEducation: educationFacts (the verbatim degree names),
  archetypeSkillLead: <archetype skill-lead group name or ''>,
});
for (const v of resumeViolations) resumeViolations_metric.inc({ code: v.code });
```
- Use `finalResume` in persistence (the tailored-resume store, metadata, the ATS check,
  the PDF render input) — replace `tailoredResumeData`.
- Metric `job_strategist_resume_violations_total{code}`.
- Fail-open.

## Testing
- `validateResume`: each code — headline-is-title vs positioning; summary wrong-cluster
  vs leading with leadIdentity; summary names-gap; education mismatch vs verbatim-match;
  skills-lead mismatch; a clean resume → no violations.
- `guardResume`: clean → unchanged no rewrite; violations → rewrite (mocked) returns fixed;
  rewrite throws → original (fail-open).
- persona/constraints: presence tests that the summary quick-map no longer hardcodes
  "Cloud infrastructure engineer" for support, the skills/lead-bullet/projects-collapse/
  education-ordering rules are present.
- run-pipeline: `finalResume` replaces the raw one in persistence + ATS + PDF input.

## Honesty
The guard only REORDERS / REWORDS / OMITS for prominence — it never fabricates, never
changes a number, never renames a degree. Education names are checked against the verified
facts. The rewrite agent is instructed: fix only the flagged issues, preserve every fact.

## Out of scope
- tucaken render changes — the resume is ALREADY structured JSON + rendered structurally
  (the cover-letter PR proved the renderers handle structured data). The field shapes are
  unchanged; only ordering/content of existing fields changes. No tucaken work expected;
  confirm the renderer tolerates a collapsed-projects shape (a role gaining a "selected
  work" line is existing-shape).
- Multi-archetype skill-lead tables beyond support — start with support + a generic
  "matched-first" rule; extend per archetype as needed.

## File list
- `applications/job-strategist/src/prompts/strategist-persona.ts` — summary/skills/lead-bullet/projects/education rules.
- `applications/job-strategist/src/prompts/resume-constraints.ts` — fix the support summary quick-map; skills-lead + projects-collapse + education-order.
- `applications/job-strategist/src/agents/resume-guard.ts` (new) + `.test.ts`.
- `applications/job-strategist/src/run-pipeline.ts` — guard wiring + metric + finalResume.
- `applications/shared/src/types.ts` — `AgentName += 'resume-rewrite'`.
