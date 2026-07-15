# lib/coach

Coach-lane helpers -- grounding, prose extraction, and validation specific to
the interview-coach output (Phone Screen, Technical, System Design, Bar
Raiser, Final).

## Files

- `bar-raiser-grounding.ts` -- Bar Raiser grounding spine; maps a user's real
  project evidence to leadership principles by signal-keyword overlap.
- `coach-grounding.ts` -- text-level grounding adapters turning coach input
  and output into a (contextChunks, answer) pair for
  `BedrockGroundingVerifier`.
- `coach-prose.ts` -- extracts `InterviewCoachResult` into tagged
  `ProseSection[]` for `BedrockProseLinter`.
- `coaching-notes-text.ts` -- flattens `coachingNotes` sections into located
  text fragments so the prose linter covers every section.
- `final-validation.ts` -- pure hygiene pass on `FinalPrep`; drops
  talking points/questions with empty text.
- `ground-talking-points.ts` -- fail-closed grounding for phone-screen
  talking points; drops any `matchedSkills` entry not in the research
  verified-match list.
- `leadership-principles-repository.ts` -- read-only repository over the
  `leadership_principles` ontology (global reference data, no RLS).

## Invariant

Every coach-emitted claim (skill transfer, talking point, principle mapping)
must be traceable to the candidate's verified project evidence or the JD
research -- never invented to fill a stage template.

## Adding a file here

Add to `coach/` if the file's invariant is specific to coach-stage output.
If the same truth-keeping logic is shared with the resume/analysis surfaces
(not coach-only), it belongs in `grounding/` instead.
