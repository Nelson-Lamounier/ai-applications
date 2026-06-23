# Cover-Letter Impact Optimisation + De-Hallucination

- **Date:** 2026-06-22
- **Status:** Design approved, awaiting spec review
- **Repo:** ai-applications / job-strategist
- **Stacked on:** `spec/experience-bullet-discipline` (PR #328) — edits the free persona those PRs introduced.

## Problem

Reviewed the last live free (`7a586686`) and paid (`7dadbe3e`) runs (Wiz Solutions
Support Engineer). Three issues:

1. **Generic letters.** Both cover letters read generic — they describe neither
   the candidate's specific achievements, the challenges he overcame, the impact
   of his decisions, nor a sharp "why this candidate". The cover letter today
   only sees a generic project pitch/stack block (`loadProjectEvidenceBlock`) +
   career facts. The rich, specific material is unused: the user has 5
   `project_challenges` (`problem → solution`, e.g. the `bedrock:Rerank`
   silent-failure investigation), 5 `project_decisions`
   (`context → decision → consequences`, where **consequences = impact**), and 5
   `project_highlights` — none of it reaches the cover letter.

2. **Fabrication (paid).** The paid letter wrote *"actively beginning Azure and
   GCP onboarding, which I am pursuing with deliberate urgency"* — the candidate
   is not studying either. **Root cause is a deliberate prompt rule**, not a
   stochastic hallucination: `prompts/resume-constraints.ts` (evidence gate)
   permits *"I am actively beginning [technology] onboarding"* for a gap with no
   confirmed activity, and `strategist-persona.ts` has a GCP gate saying
   *"Cover letter: use 'actively beginning GCP onboarding'"*. The matcher flags
   Azure/GCP as gaps (multi-cloud JD vs AWS-only evidence) → the rule converts the
   gap into a false study claim. The persona also self-contradicts ("OMIT gaps
   entirely, never fabricate" vs the onboarding gate). `cover-letter-guard` only
   catches *negative* self-rejection phrasing, so the *positive* fabrication
   slipped through; no evidence-grounding check validates cover-letter claims.

3. **Resume↔letter drift (paid).** The resume's K8s narrative is
   kubeadm→**migrated to EKS**; the letter froze on the self-managed kubeadm half
   and dropped the EKS conclusion. Both true, but inconsistent. Nothing enforces
   the letter's lead to echo the resume's headline.

The free path is cleaner (no matcher/gap machinery → no onboarding fabrication;
joint single-call generation → naturally consistent) but is still generic and
its cover letter is never graded.

## Goals

- Make the cover letter **specific and impact-led** on **both** paths: lead with a
  real challenge overcome, then JD-relevant **decision-impacts** + achievements,
  then a transferable-strength close — all grounded in the candidate's data
  (challenges, decisions, highlights, commits/PRs, projects, KB/career).
- **Never name gaps; never fabricate a "studying/onboarding" claim.** When a JD
  must-have is not evidenced, surface the closest *evidenced* transferable
  strength, framed for the role, only when relevant.
- **Cover both paths with eval** (no prompt change without its eval).

## Non-goals

- Full holistic re-grounding of the paid pipeline (its fail-open grounding
  verifier stays as-is).
- Resume content/structure (handled by #328) and the cover-letter PDF/UI.
- The matcher/research agent's gap classification itself (we change how gaps are
  *expressed*, not how they are detected).
- Any schema/DB migration (all source tables already exist + are populated).

## Verified data (queried for the test user)

| Table | Count | Fields used |
|---|---|---|
| `project_challenges` | 5 | `problem`, `solution` |
| `project_decisions` | 5 | `context`, `decision`, `consequences` (= impact) |
| `project_highlights` | 5 | `title`, `description` |
| `repo_commits` / `repo_pull_requests` | 2,671 / 674 | already wired (commit/PR evidence, #327) |

## Design

Five components, applied to both free and paid unless noted.

### 1. New "achievement & impact" evidence block (cheap DB read)
New loader `free/achievement-evidence.ts` → `loadAchievementEvidence(pool, userId): string`,
fail-open to `''`. Reads, per the user's projects (capped top-N):
- **Challenges:** `problem → solution` lines (the challenge-overcome material).
- **Decisions:** `decision → consequences` lines (**decision-impact** material —
  the consequence is the impact).
- **Highlights:** `title — description` lines (achievements).

Formatted as one compact block with three labelled groups, e.g.:
```
Challenges overcome (problem -> how it was solved):
- <problem> -> <solution>
Decision impact (decision -> consequence):
- <decision> -> <consequences>
Achievements:
- <title> — <description>
```
Wired in:
- **Free:** add `FreeEvidence.achievementEvidence: string`; `gatherFreeEvidence`
  loads it; `buildUserMessage` adds a `<achievements_and_impact>` block.
- **Paid:** the strategist message builder (`buildStrategistMessage`) adds the
  same block (a new `achievementEvidence` input threaded from the pipeline, loaded
  with the existing project-evidence load).

### 2. Persona rewrite — challenge-led, impact-led arc (prompt-only, both personas)
Rewrite the COVER LETTER CONTRACT (free `free-resume-persona.ts`) and COVER LETTER
RULES (paid `strategist-persona.ts`) to a **3-paragraph arc**:
- **P1 — hook:** a *specific* challenge overcome (from `<achievements_and_impact>`
  challenges), naming the real problem + how it was resolved; signals rare
  capability. No "I am passionate / I am writing to apply" filler.
- **P2 — why-fit (impact-led):** 2-3 beats, each a **decision + its impact**
  (`consequences`) OR a **challenge + its outcome** OR an achievement — **selected
  for relevance to the JD's must-have skills + `companyProblem`**, not the most
  technically impressive. Prefer a decision whose *consequence* speaks to what the
  role needs. Use the JD's exact skill/tool wording where the evidence supports it.
- **P3 — close:** transferable strength tied to the role; forward-looking; **no
  gaps named**.
- **Sync rule:** the letter's lead must echo the **resume's strongest
  JD-relevant achievement** (same headline tech/story as the resume).
- Keep all existing anti-hallucination hard rules.

### 3. Remove the fabrication rule; add transferable framing
- **`resume-constraints.ts`:** delete the evidence-gate line that permits
  *"I am actively beginning [technology] onboarding"*; delete/replace the GKE/GCP
  "actively onboarding" signal lines.
- **`strategist-persona.ts`:** delete the GCP EVIDENCE GATE "actively beginning
  GCP onboarding" instruction; resolve the omit-gaps-vs-onboard contradiction
  toward: **never name a gap, never claim a missing skill, never state a
  forward-looking acquisition ("studying/onboarding/learning") of an unevidenced
  skill.**
- **Replace with the transferable-framing rule** (both personas): when a JD
  must-have is not evidenced, surface the closest *evidenced* skill framed as
  transferable to the role's need (e.g. a cloud-agnostic investigation methodology
  proven on AWS), only when relevant; never name the gap or the missing skill.

### 4. `cover-letter-guard` hardening (deterministic, both paths)
Add a **positive-fabrication pattern** group to `cover-letter-guard.ts`: a
forward-looking skill-acquisition claim — `(actively|currently|presently)`
near `(begin|beginning|started?|pursuing|onboarding|learning|studying|ramping
up|upskilling|self-?teaching)` — yields a new violation code
`forward_looking_skill_claim`. The existing rewrite-on-violation (Haiku, fail-open)
strips it. This catches the Azure/GCP class deterministically even if the prompt
slips. Unit-tested directly (planted-string in → violation out).

### 5. Grounding + eval
- **Free grader:** extend `gradeFreeResume` to also scan the **cover letter**
  paragraphs (currently skipped) for employer + metric grounding against the
  evidence corpus (reuse the existing `isKnownEmployer` / metric-token gate).
- **Eval (`free-resume-writer.eval.test.ts`):**
  - **No forward-looking fabrication:** a planted "actively beginning Azure
    onboarding" cover-letter fixture is flagged by `validateCoverLetter`
    (`forward_looking_skill_claim`).
  - **Challenge-led hook:** P1 references challenge/achievement evidence (a
    problem/solution phrase appears), not generic filler.
  - **Decision-impact present:** at least one P2 beat surfaces a
    `consequences`-derived impact from the decision evidence.
  - **Transferable, no gap named:** given a JD must-have absent from evidence, the
    letter does not name the gap or claim the skill, and surfaces a related
    evidenced skill.
  - **Grounding holds:** named employers/metrics in the letter are evidence-backed.

## Architecture / data flow (cover letter, updated)

```
project_challenges + project_decisions + project_highlights  (DB, no LLM)
        │  loadAchievementEvidence → <achievements_and_impact>
        ▼
FREE:  buildUserMessage(evidence + JD must-haves/ats_keywords + companyProblem)
        → single Sonnet call → { resume, coverLetter }
        → gradeFreeResume (now also grades the letter)
        → guardCoverLetter (now flags forward_looking_skill_claim)
PAID:  buildStrategistMessage(... + achievementEvidence)
        → strategist XML → extractCoverLetter
        → guardCoverLetter (same new flag)
```

## Error handling
- `loadAchievementEvidence` fail-open to `''` (a user with no case study still
  generates a letter from career/commit/PR/KB evidence).
- The new guard pattern composes with the existing fail-open Haiku rewrite (if the
  rewrite fails, the original is kept and the violation is recorded as a metric).
- Removing the onboarding rule is purely subtractive in the prompt; no code path
  depends on it.

## Testing
- **Unit:** `loadAchievementEvidence` (formats the three groups; caps; fail-open);
  `validateCoverLetter` new `forward_looking_skill_claim` (positive cases fire,
  grounded transferable phrasing does NOT falsely fire); `gradeFreeResume`
  cover-letter employer/metric grounding.
- **Eval:** the five free-writer cover-letter assertions above.
- **Manual:** a fresh free + paid run on the Wiz JD shows a challenge-led letter
  with a JD-relevant decision-impact, no Azure/GCP "onboarding" claim, and a lead
  consistent with the resume headline.

## Acceptance criteria
- Both paths feed the cover letter the challenge/decision-impact/achievement
  evidence; persona produces the challenge-led, impact-led, transferable arc.
- No cover letter states a forward-looking acquisition of an unevidenced skill
  (deterministically caught by `cover-letter-guard`); no gap is named.
- The free grader validates the cover letter (employer + metric grounding).
- The letter's lead echoes the resume's strongest JD-relevant achievement.
- No new LLM call beyond the existing pipeline (the new loader is a DB read; the
  guard rewrite is the pre-existing fail-open Haiku call); no migration; ESLint +
  typecheck clean; eval green.

## Risks & mitigations
- **Transferable framing over-stretches into an implicit gap claim:** the persona
  forbids naming the gap or the missing skill, and the guard's
  `forward_looking_skill_claim` pattern blocks the "studying/onboarding" escape
  hatch. The eval asserts a planted gap is neither named nor claimed.
- **Guard false-positive** on legitimate phrasing (e.g. "I led the onboarding of
  new engineers"): scope the pattern to skill-acquisition context (proximity of
  "actively/currently" + acquisition verb + a skill/tech token) and unit-test a
  legitimate-"onboarding" sentence to confirm it does NOT fire.
- **Thin evidence** (user with no case study): fail-open block → the letter falls
  back to career/commit/PR/KB evidence; still no fabrication.
- **Sync rule is prompt-only:** free is joint-generation (naturally consistent);
  paid shares one XML — the persona nudge is a best-effort consistency aid, not a
  hard cross-check (full cross-validation is out of scope).
