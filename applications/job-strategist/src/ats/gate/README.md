# gate/

The ATS-check GATE. Renders the finished resume to PDF, parses it back, scores JD
keyword coverage against the parsed text, and stores the result. In: `finalResume`
(StructuredResumeData) + research verdicts. Out: `AtsCheckResult` persisted to
`resumes.ats_check_json` + PDF to S3. Entry point: `renderCheckAndStoreAts`
(`run-ats-check.ts`), called from `run-pipeline.ts`. Also holds the free-tier
coverage/fit functions (`grounded-coverage.ts`, `evidence-fit.ts`) and the
attainable-keyword split (`attainable.ts`).
