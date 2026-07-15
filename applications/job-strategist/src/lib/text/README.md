# lib/text

Format-level string utilities with no domain knowledge -- callable from any
pipeline without knowing what a resume, a coach stage, or a KB is.

## Files

- `strip-cdata.ts` -- strips a complete XML CDATA wrapper the model
  occasionally bleeds into free-text fields (e.g. `coachingNotes`); a stray,
  incomplete delimiter is left untouched.
- `strip-document-sections.ts` -- trims the grounding-verifier's `answer`
  input down to what it actually judges, excluding sections that already
  have their own dedicated guards (resume-guard, number-provenance,
  cover-letter-guard).

## Invariant

Every function here is pure, total, and format-level only -- no knowledge of
resume fields, coach stages, or evidence semantics. If a transform needs to
know what a field *means*, it does not belong here.

## Adding a file here

Add to `text/` only if the file is a generic string transform with zero
domain knowledge and no I/O. The moment a helper needs to reason about
resume/coach/grounding semantics, it belongs in that domain folder instead.
