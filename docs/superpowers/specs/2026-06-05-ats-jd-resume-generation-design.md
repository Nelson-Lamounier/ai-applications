# ATS Quality Embedded in JD-Driven Resume Generation — Design

**Date:** 2026-06-05
**Status:** Approved (design); awaiting implementation plan
**Branch:** `feat/ats-jd-resume-generation`
**Repos touched:** `ai-applications` (backend/pipeline), `tucaken-app` (frontend)

---

## 1. Background & framing

The portfolio's resume generation is AI-driven. During onboarding the user uploads a
PDF resume; its content is ingested into the knowledge base (KB). When the user applies
for a job, the **Strategist agent (Sonnet 4.6)** generates a *new* resume from
**KB evidence + the job description (JD)** — it does **not** reformat the user's previous
resume. The JD-tailored resume is the artifact that goes to employers.

ATS quality is therefore **not** a standalone feature or a per-resume manual validator.
It is an **intrinsic property of the JD-driven generation workflow**. The work here
embeds ATS-readability into that pipeline and adds an honest, JD+Company-scoped UI signal
that the generated resume passes ATS.

### The critical defect this fixes

Today the frontend exports resumes via `html2canvas → jsPDF`, producing an
**image-based PDF**. Text is not selectable, so an ATS extracts **zero** text — the
clean single-column layout is moot. Per the 2026 ATS research: *"Image-based PDFs — if
you can't highlight and copy the text, the ATS can't read it either."* This design
replaces that path (for JD-tailored resumes) with a real text-layer PDF and proves
readability with a parse-back check.

### The check is also AI-output QA

Because the resume is AI-generated, the parse-back check serves **two purposes at once**:

1. **User-facing trust signal** — "this resume passes ATS for this Job + Company."
2. **QA gate on the AI's output** — verification that the model's generated resume is
   actually machine-readable and covers the grounded JD must-haves.

This satisfies the repo's standing LLM rule (`CLAUDE.md`): *per-phase evals are
non-negotiable; no prompt change ships without its eval.* The ATS check exists both as a
runtime QA gate **and** as an eval grader for the generation phase.

---

## 2. Architecture decision

**Chosen: Approach A — server-rendered canonical ATS resume.**

The resume layout is authored once in `@react-pdf/renderer` primitives. Because
`@react-pdf/renderer` is **isomorphic** (runs in Node via `renderToBuffer` and in the
browser), the layout executes inside the `ai-applications` generation K8s job. The
pipeline renders the AI's structured resume to a PDF buffer, parses it back to validate
ATS-readability, stores the canonical PDF (S3) and the check result (DB), and the frontend
downloads the stored PDF and renders the checklist UI.

**Why A over the alternatives:**

- The "passes ATS" badge is a **trust claim**. It must be computed server-side — next to
  the JD/Company context, on the exact bytes the user downloads — so it cannot be spoofed.
- Validation is co-located with the JD must-have data (already extracted by the Research
  Agent) and the KB grounding citations.
- Avoids cross-repo coupling now. (Rejected **C — shared layout npm package** because of
  cross-repo versioning overhead and the type-drift hazard that previously caused
  production coach bugs. Rejected **B — client render + client validation** because
  in-browser validation is spoofable and not authoritative.)

The existing **manual resume builder** in `tucaken-app` is unchanged; it has a different
lifecycle. Only the JD-tailored resume path is affected. A can later evolve into C if the
manual builder needs the same layout.

---

## 3. The ATS check — `ATSCheckResult`

Computed in-pipeline by rendering the AI's `StructuredResumeData` to PDF and parsing the
bytes back:

| Field | Meaning |
|---|---|
| `machineReadable: boolean` | Text actually extracts from the rendered PDF (the defect being fixed). |
| `standardSectionsDetected: string[]` | Standard headers recognized: Experience / Skills / Education / etc. |
| `contactDetected: { name, email }` | Contact found **in the document body**, not in a header/footer region. |
| `parseBreakers: string[]` | Tables / multi-column / images / header-footer content. Empty by construction of the layout. |
| `jdKeywordCoverage: { term, present, grounded }[]` | JD must-haves (from the Research Agent) present in the resume **and** grounded in KB evidence. |
| `passed: boolean` | Gate verdict. |
| `status: 'passed' \| 'issues' \| 'unverified'` | `unverified` when the parse tooling itself errors — never silently `passed`. |
| `issues: string[]` | Human-readable problems. |

**No fabricated percentage.** A pass means concrete assertions were met. The UI shows a
checklist, not an opaque score (per the research's explicit anti-snake-oil guidance).

---

## 4. QA loop on the AI output

After generation: **render → check**.

- If `passed` → store and surface.
- If `!passed` for a **fixable** reason (a grounded JD must-have missing from the resume, a
  standard section absent), run **one bounded repair**: a single targeted regeneration with
  the `issues[]` fed back, then re-check. **Max 1 retry** (cost guard).
- If still failing after the repair → persist with `issues[]` surfaced. **Never silently
  claim pass.**
- If the parse tooling itself errors → `status: 'unverified'` (fail-closed). Never
  `passed` without evidence.

This mirrors the repo's `verification-before-completion` discipline and the security
guardrail of failing closed.

---

## 5. Components

### 5.1 `ai-applications` (backend / pipeline)

| Path | Purpose |
|---|---|
| `applications/job-strategist/src/render/resume-pdf/` | `@react-pdf` layout: single-column, standard headers, contact in body, **no tables / no multi-column / no header-footer content / no images**, embedded standard font. Isomorphic — runs in the Node K8s job. |
| `applications/job-strategist/src/render/render-resume-pdf.ts` | `renderToBuffer(StructuredResumeData): Promise<Buffer>`. |
| `applications/job-strategist/src/ats/parse-back.ts` | Parse the PDF buffer back to text + detected sections (`pdf-parse` or equivalent). |
| `applications/job-strategist/src/ats/checks.ts` | Assertions producing `ATSCheckResult`, including JD must-have cross-reference + grounding. |
| `applications/job-strategist/src/ats/ats-check.schema.ts` | Zod schema for `ATSCheckResult`. |
| `applications/job-strategist/evals/ats-grader.ts` | Same checks as a graded eval (per the non-negotiable per-phase-eval rule). |
| `applications/job-strategist/src/ats/calibration/` | **Dev-only** offline script: run sample PDFs through the **Affinda free tier**, diff vs the in-house checks to calibrate. Not in the hot path. |
| `applications/job-strategist/src/lib/pipeline-runs.ts` | Wire after `persistTailoredResume`: render → check → bounded repair → store PDF (S3) + `ats_check_json` (DB). Idempotent / transactional; track created IDs (retryable-persistence guardrail). |
| Strategist prompt deltas | (1) `summary` rewritten to be **recruiter-blurb-optimized**; (2) explicit **top-third ordering rules** (quantified outcomes in latest role first); (3) strengthen **JD-term usage** so the resume uses the JD's exact terminology where grounded — JD alignment **baked in, invisible**, no new UI field. |
| Migration | Add `resumes.pdf_s3_key`, `resumes.ats_check_json`. Numbered runner with checksum ledger per repo guardrail. |

### 5.2 `tucaken-app` (frontend)

| Path / area | Purpose |
|---|---|
| Tailored-resume API (`src/server/applications.ts` + admin/public API) | Serve the stored canonical PDF (text-selectable) and `ATSCheckResult` for the application's tailored resume. |
| ATS checklist panel (in the tailored-resume view, e.g. `ResumesDisplayer`) | Render pass + per-check items, scoped to **Job + Company**. Honest checklist; **no number**. |
| JD-tailored download path | Fetch the stored canonical PDF instead of `html2canvas`. The **manual builder** download path is untouched in this scope. |

---

## 6. Data flow

```
Onboarding:  user PDF ─► KB (existing ingestion)

Apply to job:
  trigger
   └─► Research Agent      (JD requirements + must-have keywords)
        └─► Strategist     (StructuredResumeData: blurb-optimized summary,
                            JD-term usage, top-third ordering)
             └─► render @react-pdf  ─► PDF buffer
                  └─► parse-back QA check  ─► ATSCheckResult
                       └─► [≤1 bounded repair if fixable failure]
                            └─► store PDF (S3) + ats_check_json (DB)
                                 └─► Frontend: ATS checklist UI
                                              + download canonical PDF
```

---

## 7. Error handling

- **Render failure** → fail loudly; do **not** persist a partial resume.
- **Parse-tool failure** → `status: 'unverified'`; never `passed` without evidence.
- **Persistence** → S3 + DB writes idempotent and transactional; every created row/ID
  tracked (retryable-import-persistence guardrail).
- **Repair** → capped at 1 attempt to bound cost; no regeneration loop.

---

## 8. Testing & evals

- **Unit:** parse-back assertions; `ATSCheckResult` schema; render smoke test
  (`renderToBuffer` yields a non-empty PDF whose text is extractable).
- **Eval (`ats-grader`):** generated resume must pass `machineReadable` +
  `standardSectionsDetected` (Experience/Skills/Education) + `contactDetected` +
  zero `parseBreakers`; `jdKeywordCoverage` reported. Runs with the existing grader suite
  on every prompt change.
- **Calibration (dev):** Affinda free-tier diff against in-house checks to confirm the
  in-house parser agrees with a real enterprise parser on the controlled layout.

---

## 9. Phasing

| Phase | Scope | Why it's the boundary |
|---|---|---|
| **P0** | `@react-pdf` layout + server render + parse-back QA gate + store PDF/check + `ats-grader` eval. | Makes resumes actually parse **and** QAs the AI output. The core; everything else is moot without it. |
| **P1** | DOCX export (server-side `docx` from the same `StructuredResumeData`) + recruiter-blurb `summary` prompt/eval + top-third ordering rules. | Format breadth + the stated differentiator (strong machine summary). Independent of P0 mechanics. |
| **P2** | JD-term usage strengthening + ATS checklist UI in `tucaken-app` + Affinda offline calibration. | User-facing surface + external calibration; depends on P0 producing the check. |

---

## 10. Out of scope

- The manual resume builder's render/download path (unchanged).
- Any numeric "ATS score" gauge (explicitly rejected per research).
- AI-content-detection evasion (a non-problem per research; no major ATS detects it).
- Cross-repo shared layout package (deferred; revisit if the manual builder needs parity).
- Per-user real-time Affinda calls in the hot path (calibration only).
