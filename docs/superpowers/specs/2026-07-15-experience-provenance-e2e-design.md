# Experience Lane: End-to-End Provenance + Evidence-Anchored ATS Verification -- Design

**Date:** 2026-07-15
**Status:** Approved design -- pending implementation plan
**Driver:** Run a7356cc5 diagnostics review. Four gaps: dropped-line reasons
discarded (G1); provenance held only at agent time while the guard chain
rewrote validated bullets (G2); coverage scored on an intermediate document
(G3); coverage matching was exact-adjacent-phrase, so real evidence such as
"Amazon Linux (AL2/AL2023) system setup" never covered the target "Linux
systems engineering" (G4).

**User decisions (locked):**
- G2 approach: experience is IMMUTABLE after its agent -- enforce the existing
  design intent (the `job_strategist_section_net_fired_total` comment already
  calls downstream mutation "unexpected... ideally always zero").
- G4 approach: evidence-anchored + term-tolerant coverage, EXPERIENCE LANE
  ONLY. The summary lane's strict adjacent-phrase scorer is a separate locked
  decision (Phase 3) and does not change.
- Fail-closed grounding stands: no bullet without a citable career line; a
  target with no anchor and no term match stays honestly missing.

## Component 1 -- Dropped-line observability (G1)

`accounting.dropped` is the agent's forced declaration of unused career lines
(provenance rule (b)). Today only its count survives.

- `ExperienceAgentDiagnostics.provenance` gains
  `dropped: ReadonlyArray<{ line: string; reason: string }>` -- reasons capped
  at 200 chars, array capped at 30 entries (career lines are LIMIT 8 roles x
  bullets; 30 is a safe ceiling). `droppedLines` (the count) stays for
  dashboard continuity.
- `logExperienceAgentEvents` emits a new Loki event
  `experience_agent_dropped` with the array, only when non-empty.
- The bounded array persists inside
  `pipeline_runs.metadata.analysis.experienceAgent.provenance.dropped`.
- Prometheus is untouched (no unbounded strings in labels -- standing rule).

## Component 2 -- Experience locked after its agent (G2)

Files: `agents/writer/experience-lock.ts` (new), `run-pipeline.ts` splice
points, `ats/length/length-budget.ts`, `agents/quality/resume-guard.ts`.

- New helper `withExperienceLock(resume, passName, fn, onRestored)`:
  snapshot `resume.experience` (structuredClone), run the pass, and if the
  pass changed the section, restore the snapshot and report
  `{ pass: passName }` via `onRestored`. Generalises the metric-weave
  snapshot-restore at run-pipeline.ts:1359-1370 (which migrates onto the
  helper -- single source of the pattern).
- Applied to EVERY post-agent pass that can touch the resume: guard repair
  (`guardResume` repair path), `revalidateResumeContent`,
  `reframeStaleMigrations`, `surfaceMetrics`, metric weave, length
  condense/expand, `hardTrim`, `surfaceKeywords`. The ATS keyword loop's
  `restoreProjectHighlights` twin stays as is (projects lane out of scope).
- `job_strategist_section_net_fired_total` gains label `outcome` with values
  `restored` (lock fired and reverted the change) -- the counter turns from
  tripwire into enforcement log. Existing series keep meaning via
  `outcome="changed"` for the projects section (still observe-only).
- Deterministic experience length control, whole-bullet only:
  `hardTrimExperience` never runs `trimSentences` inside an experience
  bullet; it may only `slice` to `maxBulletsPerRole`. The per-bullet 32-word
  cap becomes an experience-agent CONTRACT (prompt rule + eval case), not a
  post-hoc mutation. Roles keep `minBulletsPerRole` (2) whenever they have
  2+ bullets.
- `experience_bullet_jd_echo` on an experience bullet is EXCLUDED from the
  generic Haiku repair rewrite. Instead: at most ONE routed re-write through
  the experience agent's own rewrite lane (`strategist-experience-rewrite`,
  provenance-validated as today, echo flags passed in the message); if that
  re-write fails validation or still echoes, the original agent text stands
  and the violation is recorded as advisory (`violation_log` stage
  `resume_guard`, code unchanged).
- Because the shipped text is byte-identical to the validated
  `ExperienceAgentOutput`, the `sources` arrays already persisted with the
  diagnostics ARE the provenance record of the final document. No shared
  resume-schema change.

## Component 3 -- Final-text coverage (G3)

- Coverage is scored twice with the SAME scorer (Component 4): once at
  decision time (drives the one bounded re-write -- unchanged fire rule:
  `targets.length > 0 && covered < targets.length`), once on the FINAL
  experience section immediately before persist.
- `ExperienceAgentDiagnostics` gains `coverageFinal: SummaryCoverage | null`;
  Loki event `experience_agent_coverage_final`; persisted with the rest.
- Assert: with Component 2 in force, final text === agent text, so
  `coverageFinal` must equal the kept candidate's coverage. On inequality
  record violation code `experience_mutated_downstream` (violation_log,
  stage `resume_integrity`) -- diagnostics must never describe a document
  that no longer exists.

## Component 4 -- Evidence-anchored, term-tolerant coverage (G4)

Files: `ats/gate/experience-coverage.ts` (new),
`ats/gate/experience-ats-targets.ts`, `agents/writer/experience-message.ts`.

- `ExperienceAtsTarget` gains `anchors: string[]` -- indexed career line ids
  (`c{i}.h{j}`) whose text term-matches the target (rule below), computed
  deterministically in `selectExperienceAtsTargets` from the same career
  lines the agent receives. Zero-anchor targets are still selectable.
- New `scoreExperienceCoverage(bullets, targets)` where each bullet carries
  `{ text, sources }` (available at both scoring points from the kept
  `ExperienceAgentOutput`). A target is COVERED when some single bullet:
  (a) cites one of the target's anchor lines in `sources`, OR
  (b) term-matches the target text: every REQUIRED term of the target
  appears whole-word (normalised via the matching subsystem's
  `normalizeTerm`/`padded`) in that one bullet, order-free.
- REQUIRED terms = the target's tokens minus the fixed generic list
  `GENERIC_TARGET_TOKENS = [systems, system, engineering, experience,
  analysis, skills, skill, knowledge, management, ability, and, of, the]`.
  Examples: "Linux systems engineering" -> {linux}; "production database
  systems" -> {production, database}; "performance and scalability
  analysis" -> {performance, scalability}. A target whose tokens are ALL
  generic keeps its full token set (never an empty requirement).
- The summary lane keeps `scoreSummaryCoverage` untouched, including its
  do-not-relax comment.
- Anchored prompt: `experience-message.ts` renders each target with its
  anchors and the anchor lines' text:
  `TARGET: Linux systems engineering -- grounded by [c0.h6] "Guided
  customers through Amazon Linux (AL2 and AL2023) system setup..." -- write
  a bullet FROM a grounding line that covers this target; cite the line id.`
  Targets with no anchors render with an explicit honesty rule: only cover
  it if an existing career line genuinely supports it; otherwise leave it
  and it will be reported as a gap.
- Fail-closed unchanged: provenance rules (a)-(d) still validate every
  output; anchors add information, never permission to invent.

## Error handling

Every new path fails open to current behaviour: lock helper returns the
pass's output unchanged if the experience section is untouched; scorer and
anchor computation are pure functions (no I/O); dropped-array logging and
persistence are best-effort alongside the existing diagnostics write.

## Testing

- Unit: experience-lock (mutating pass restored + reported; non-mutating
  pass untouched); scoreExperienceCoverage (anchor-covered, term-covered,
  both, neither -- including the live run's Linux/AL2023 case verbatim and
  the all-generic-tokens edge); anchor computation; hardTrimExperience
  whole-bullet-only; jd_echo routing (valid re-write kept, invalid re-write
  discarded + advisory).
- Eval (CLAUDE.md rule 5): extend the experience eval set with the anchored
  Linux case, a term-tolerant case, and a no-evidence target that must stay
  missing.
- Gates: full job-strategist suite green, tsc, ROOT eslint, prompt-manifest/
  drift tests untouched or updated deliberately.
- Live validation: next JD A/B reads `coverageFinal` (the honest number),
  `experience_agent_dropped`, and expects
  `job_strategist_section_net_fired_total{section="experience",
  outcome="restored"}` to be 0 in the steady state.

## Consequences

- The "no hallucinations" guarantee covers the SHIPPED text, not just the
  agent output; diagnostics describe the persisted document.
- "Which lines were dropped and why" is answerable for every future run.
- Targets stop being permanently "missing" for phrasing reasons; the agent
  is told exactly which career evidence grounds each target, matching the
  user's verification model (role/company evidence -> JD+ATS bullet).
