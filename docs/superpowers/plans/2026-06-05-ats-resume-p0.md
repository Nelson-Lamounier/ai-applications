# ATS Resume Generation — P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the JD-tailored, AI-generated resume render as a real text-selectable PDF and prove it is ATS-readable with an in-pipeline parse-back QA check, stored alongside the resume and surfaced as a grader.

**Architecture:** Architecture A from the spec. The Strategist's `StructuredResumeData` is rendered to a PDF buffer **inside the `job-strategist` K8s job** using `@react-pdf/renderer` (isomorphic — runs in Node). The buffer is parsed back (`pdf-parse`) and asserted against ATS rules + the JD must-haves already extracted by the Research Agent, producing an `ATSCheckResult`. The canonical PDF is stored in S3 and the check JSON in `resumes`. The same check logic is also registered as an eval grader (per the repo's non-negotiable per-phase-eval rule).

**Tech Stack:** TypeScript (CommonJS, NodeNext module resolution — local imports use `.js` extension), Jest, Zod, `@react-pdf/renderer`, `pdf-parse`, `@aws-sdk/client-s3` (already a dependency), Postgres (`pg`).

**Spec:** `docs/superpowers/specs/2026-06-05-ats-jd-resume-generation-design.md`

**Scope note:** This plan covers **P0 only**: render → parse-back check → store → grader. The bounded auto-repair loop (§4 of the spec) is included as **Task 10**, explicitly marked as a fast-follow because it extends the Strategist agent's input contract; P0 ships and QAs the AI output (detect + report + grade) without it. P1 (DOCX, recruiter-blurb summary) and P2 (JD-term strengthening, frontend checklist UI, Affinda calibration) get their own plans.

---

## File Structure

| File | Responsibility |
|---|---|
| `applications/job-strategist/package.json` | Add `@react-pdf/renderer`, `pdf-parse` deps. |
| `applications/job-strategist/src/render/react-pdf.ts` | ESM-interop wrapper that loads `@react-pdf/renderer` (ESM) into the CommonJS build via dynamic `import()`. Single import surface for the rest of the code. |
| `applications/job-strategist/src/render/resume-pdf/ResumePdf.tsx` | The `@react-pdf` document layout: single-column, standard section headers, contact in body, no tables/columns/images/header-footer. |
| `applications/job-strategist/src/render/render-resume-pdf.ts` | `renderResumePdf(data: StructuredResumeData): Promise<Buffer>` — wraps `renderToBuffer`. |
| `applications/job-strategist/src/ats/ats-check.schema.ts` | Zod schema + exported `AtsCheckResult` type. |
| `applications/job-strategist/src/ats/parse-back.ts` | `parsePdfBack(buf: Buffer): Promise<{ text: string; sections: string[] }>`. |
| `applications/job-strategist/src/ats/checks.ts` | `buildAtsCheck(args): AtsCheckResult` — pure assertions over extracted text + structured data + JD must-haves. |
| `applications/job-strategist/src/ats/jd-keywords.ts` | `collectJdMustHaves(research): string[]` and `collectGroundedTerms(research): Set<string>` — pulls JD must-haves + grounded terms from the research result. |
| `applications/job-strategist/src/ats/store-ats-artifacts.ts` | `storeAtsArtifacts(...)` — uploads PDF to S3 + updates `resumes` row idempotently. |
| `applications/job-strategist/src/evals/graders/ats-grader.ts` | `atsGrader` — same checks as a `Grader`-style eval. |
| `applications/platform-rds-bootstrap/migrations/067_resume_ats_columns.sql` | Adds `resumes.pdf_s3_key`, `resumes.ats_check_json`. |
| `applications/job-strategist/src/run-pipeline.ts` | Wire render → check → store after `persistTailoredResume` (Task 9). |

---

## Task 1: Add dependencies + ESM-interop wrapper

**Files:**
- Modify: `applications/job-strategist/package.json`
- Create: `applications/job-strategist/src/render/react-pdf.ts`
- Test: `applications/job-strategist/src/render/react-pdf.test.ts`

`@react-pdf/renderer` v4 ships as ESM; this package is CommonJS. The wrapper isolates the dynamic `import()` so the rest of the codebase imports a normal async function. `pdf-parse` is CommonJS and imports directly.

- [ ] **Step 1: Add deps**

```bash
cd applications/job-strategist
yarn add @react-pdf/renderer@^4.0.0 pdf-parse@^1.1.1
yarn add -D @types/pdf-parse
```

- [ ] **Step 2: Write the wrapper**

Create `applications/job-strategist/src/render/react-pdf.ts`:

```ts
/** @format */
// @react-pdf/renderer v4 is ESM-only; this CommonJS package loads it via a
// cached dynamic import so callers get a normal async accessor.
type ReactPdf = typeof import('@react-pdf/renderer');

let cached: Promise<ReactPdf> | null = null;

export function loadReactPdf(): Promise<ReactPdf> {
    if (!cached) {
        cached = import('@react-pdf/renderer');
    }
    return cached;
}
```

- [ ] **Step 3: Write the failing test**

Create `applications/job-strategist/src/render/react-pdf.test.ts`:

```ts
/** @format */
import { loadReactPdf } from './react-pdf.js';

describe('loadReactPdf', () => {
    it('loads the @react-pdf/renderer module with renderToBuffer', async () => {
        const mod = await loadReactPdf();
        expect(typeof mod.renderToBuffer).toBe('function');
        expect(typeof mod.Document).toBe('function');
    });
});
```

- [ ] **Step 4: Run test**

Run: `cd applications/job-strategist && yarn jest src/render/react-pdf.test.ts`
Expected: PASS. If it fails on ESM `import()` transpilation, confirm `tsconfig` `module` is `NodeNext`/`Node16` (dynamic import must be preserved, not down-levelled to `require`). Do not change unrelated tsconfig options.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/package.json applications/job-strategist/yarn.lock applications/job-strategist/src/render/react-pdf.ts applications/job-strategist/src/render/react-pdf.test.ts
git commit -m "feat(ats): add react-pdf + pdf-parse deps and ESM-interop wrapper"
```

---

## Task 2: Resume PDF layout component

**Files:**
- Create: `applications/job-strategist/src/render/resume-pdf/ResumePdf.tsx`

ATS-safe by construction: one column, standard headers (`Experience`, `Skills`, `Education`, `Certifications`, `Projects`), contact line in the body (never a header/footer), no `Table`, no multi-column `View` rows for content, no images. Uses a built-in standard font (`Helvetica`) so text is always extractable.

- [ ] **Step 1: Create the component**

Create `applications/job-strategist/src/render/resume-pdf/ResumePdf.tsx`:

```tsx
/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import React from 'react';

const s = StyleSheet.create({
    page:      { paddingVertical: 40, paddingHorizontal: 40, fontSize: 10, fontFamily: 'Helvetica', lineHeight: 1.35 },
    name:      { fontSize: 18, fontFamily: 'Helvetica-Bold' },
    title:     { fontSize: 11, marginBottom: 2 },
    contact:   { fontSize: 9, marginBottom: 10 },
    section:   { fontSize: 12, fontFamily: 'Helvetica-Bold', marginTop: 12, marginBottom: 4 },
    item:      { marginBottom: 6 },
    itemHead:  { fontFamily: 'Helvetica-Bold' },
    bullet:    { marginLeft: 10, marginBottom: 1 },
    summary:   { marginBottom: 4 },
});

export function ResumePdf({ data }: { data: StructuredResumeData }): React.ReactElement {
    const p = data.profile;
    const contact = [p.email, p.location, p.linkedin, p.github, p.website].filter(Boolean).join('  •  ');
    return (
        <Document>
            <Page size="A4" style={s.page}>
                <Text style={s.name}>{p.name}</Text>
                <Text style={s.title}>{p.title}</Text>
                <Text style={s.contact}>{contact}</Text>

                {data.summary ? (<><Text style={s.section}>Summary</Text><Text style={s.summary}>{data.summary}</Text></>) : null}

                <Text style={s.section}>Experience</Text>
                {data.experience.map((e, i) => (
                    <View key={i} style={s.item} wrap={false}>
                        <Text style={s.itemHead}>{e.title} — {e.company}</Text>
                        <Text>{e.period}</Text>
                        {e.highlights.map((h, j) => (<Text key={j} style={s.bullet}>• {h}</Text>))}
                    </View>
                ))}

                <Text style={s.section}>Skills</Text>
                {data.skills.map((c, i) => (<Text key={i} style={s.bullet}>{c.category}: {c.skills.join(', ')}</Text>))}

                {data.projects.length ? (<><Text style={s.section}>Projects</Text>
                    {data.projects.map((pr, i) => (<Text key={i} style={s.bullet}>{pr.name}: {pr.description}</Text>))}</>) : null}

                <Text style={s.section}>Education</Text>
                {data.education.map((ed, i) => (<Text key={i} style={s.bullet}>{ed.degree}, {ed.institution} ({ed.period})</Text>))}

                {data.certifications.length ? (<><Text style={s.section}>Certifications</Text>
                    {data.certifications.map((ct, i) => (<Text key={i} style={s.bullet}>{ct.name} — {ct.issuer} ({ct.year})</Text>))}</>) : null}
            </Page>
        </Document>
    );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd applications/job-strategist && yarn typecheck`
Expected: no errors. If JSX errors, confirm `tsconfig` has `"jsx": "react"` and `react` is resolvable (add `react` + `@types/react` as deps if the build complains: `yarn add react && yarn add -D @types/react`).

- [ ] **Step 3: Commit**

```bash
git add applications/job-strategist/src/render/resume-pdf/ResumePdf.tsx applications/job-strategist/package.json applications/job-strategist/yarn.lock
git commit -m "feat(ats): ATS-safe single-column react-pdf resume layout"
```

---

## Task 3: Render to buffer + smoke test

**Files:**
- Create: `applications/job-strategist/src/render/render-resume-pdf.ts`
- Test: `applications/job-strategist/src/render/render-resume-pdf.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/render/render-resume-pdf.test.ts`:

```ts
/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { renderResumePdf } from './render-resume-pdf.js';

const SAMPLE: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin, DE' },
    summary: 'Platform engineer with Kubernetes and AWS experience.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran 25 ArgoCD applications across EKS.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes', 'AWS', 'Terraform'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [],
    projects: [],
    keyAchievements: [],
};

describe('renderResumePdf', () => {
    it('produces a non-empty PDF buffer with a %PDF header', async () => {
        const buf = await renderResumePdf(SAMPLE);
        expect(buf.length).toBeGreaterThan(1000);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn jest src/render/render-resume-pdf.test.ts`
Expected: FAIL — `Cannot find module './render-resume-pdf.js'`.

- [ ] **Step 3: Write implementation**

Create `applications/job-strategist/src/render/render-resume-pdf.ts`:

```ts
/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import React from 'react';

import { loadReactPdf } from './react-pdf.js';
import { ResumePdf } from './resume-pdf/ResumePdf.js';

/** Render the AI-authored resume to a text-selectable PDF buffer (Node, no browser). */
export async function renderResumePdf(data: StructuredResumeData): Promise<Buffer> {
    const { renderToBuffer } = await loadReactPdf();
    return renderToBuffer(React.createElement(ResumePdf, { data }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn jest src/render/render-resume-pdf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/render/render-resume-pdf.ts applications/job-strategist/src/render/render-resume-pdf.test.ts
git commit -m "feat(ats): render StructuredResumeData to text-selectable PDF buffer"
```

---

## Task 4: Parse-back extraction

**Files:**
- Create: `applications/job-strategist/src/ats/parse-back.ts`
- Test: `applications/job-strategist/src/ats/parse-back.test.ts`

`parsePdfBack` extracts the raw text and detects which standard section headers survived. This proves the rendered PDF is machine-readable (the defect being fixed).

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/ats/parse-back.test.ts`:

```ts
/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { renderResumePdf } from '../render/render-resume-pdf.js';
import { parsePdfBack } from './parse-back.js';

const SAMPLE: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin, DE' },
    summary: 'Platform engineer.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran EKS.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [], projects: [], keyAchievements: [],
};

describe('parsePdfBack', () => {
    it('extracts selectable text and detects standard sections', async () => {
        const buf = await renderResumePdf(SAMPLE);
        const { text, sections } = await parsePdfBack(buf);
        expect(text).toContain('Jane Doe');
        expect(text).toContain('jane@example.com');
        expect(sections).toEqual(expect.arrayContaining(['Experience', 'Skills', 'Education']));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn jest src/ats/parse-back.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `applications/job-strategist/src/ats/parse-back.ts`:

```ts
/** @format */
import pdfParse from 'pdf-parse';

/** Standard ATS section headers we expect a parseable resume to expose. */
export const STANDARD_SECTIONS = ['Summary', 'Experience', 'Skills', 'Projects', 'Education', 'Certifications'] as const;

export interface ParsedPdf {
    readonly text: string;
    readonly sections: string[];
}

/** Extract text from a rendered PDF and detect which standard headers survived. */
export async function parsePdfBack(buf: Buffer): Promise<ParsedPdf> {
    const parsed = await pdfParse(buf);
    const text = parsed.text ?? '';
    const sections = STANDARD_SECTIONS.filter(h =>
        new RegExp(`(^|\\n)\\s*${h}\\s*(\\n|$)`, 'i').test(text),
    );
    return { text, sections };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn jest src/ats/parse-back.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/ats/parse-back.ts applications/job-strategist/src/ats/parse-back.test.ts
git commit -m "feat(ats): parse rendered resume PDF back to text + detected sections"
```

---

## Task 5: ATSCheckResult schema

**Files:**
- Create: `applications/job-strategist/src/ats/ats-check.schema.ts`
- Test: `applications/job-strategist/src/ats/ats-check.schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/ats/ats-check.schema.test.ts`:

```ts
/** @format */
import { AtsCheckResultSchema } from './ats-check.schema.js';

describe('AtsCheckResultSchema', () => {
    it('accepts a well-formed passed result', () => {
        const r = AtsCheckResultSchema.safeParse({
            machineReadable: true,
            standardSectionsDetected: ['Experience', 'Skills', 'Education'],
            contactDetected: { name: 'Jane Doe', email: 'jane@example.com' },
            parseBreakers: [],
            jdKeywordCoverage: [{ term: 'Kubernetes', present: true, grounded: true }],
            status: 'passed',
            passed: true,
            issues: [],
        });
        expect(r.success).toBe(true);
    });

    it('rejects an invalid status', () => {
        const r = AtsCheckResultSchema.safeParse({
            machineReadable: true, standardSectionsDetected: [], contactDetected: { name: '', email: '' },
            parseBreakers: [], jdKeywordCoverage: [], status: 'maybe', passed: false, issues: [],
        });
        expect(r.success).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn jest src/ats/ats-check.schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `applications/job-strategist/src/ats/ats-check.schema.ts`:

```ts
/** @format */
import { z } from 'zod';

export const AtsKeywordCoverageSchema = z.object({
    term:     z.string(),
    present:  z.boolean(),
    grounded: z.boolean(),
});

export const AtsCheckResultSchema = z.object({
    machineReadable:          z.boolean(),
    standardSectionsDetected: z.array(z.string()),
    contactDetected:          z.object({ name: z.string(), email: z.string() }),
    parseBreakers:            z.array(z.string()),
    jdKeywordCoverage:        z.array(AtsKeywordCoverageSchema),
    status:                   z.enum(['passed', 'issues', 'unverified']),
    passed:                   z.boolean(),
    issues:                   z.array(z.string()),
});

export type AtsCheckResult = z.infer<typeof AtsCheckResultSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn jest src/ats/ats-check.schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/ats/ats-check.schema.ts applications/job-strategist/src/ats/ats-check.schema.test.ts
git commit -m "feat(ats): ATSCheckResult zod schema"
```

---

## Task 6: JD must-have extraction + the check assertions

**Files:**
- Create: `applications/job-strategist/src/ats/jd-keywords.ts`
- Create: `applications/job-strategist/src/ats/checks.ts`
- Test: `applications/job-strategist/src/ats/checks.test.ts`

`jd-keywords.ts` pulls the JD must-haves (hard requirements + infrastructure/tools) and the set of terms the Research Agent verified against the KB. `checks.ts` is pure: text + structured data + those term lists → `AtsCheckResult`. `grounded` = the JD term has KB evidence (it appears in `verifiedMatches`/`partialMatches`).

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/ats/checks.test.ts`:

```ts
/** @format */
import { buildAtsCheck } from './checks.js';

const TEXT = [
    'Jane Doe', 'Platform Engineer', 'jane@example.com',
    'Experience', 'SRE — Acme', 'Ran Kubernetes on AWS.',
    'Skills', 'Infra: Kubernetes, AWS',
    'Education', 'BSc CS, TU Berlin',
].join('\n');

describe('buildAtsCheck', () => {
    it('passes a clean machine-readable resume covering grounded JD must-haves', () => {
        const r = buildAtsCheck({
            text: TEXT,
            sections: ['Experience', 'Skills', 'Education'],
            profile: { name: 'Jane Doe', email: 'jane@example.com' },
            jdMustHaves: ['Kubernetes', 'AWS'],
            groundedTerms: new Set(['kubernetes', 'aws']),
        });
        expect(r.machineReadable).toBe(true);
        expect(r.parseBreakers).toEqual([]);
        expect(r.passed).toBe(true);
        expect(r.status).toBe('passed');
        expect(r.jdKeywordCoverage).toEqual(expect.arrayContaining([
            { term: 'Kubernetes', present: true, grounded: true },
            { term: 'AWS', present: true, grounded: true },
        ]));
    });

    it('flags issues when a required section is missing', () => {
        const r = buildAtsCheck({
            text: 'Jane Doe\njane@example.com\nExperience\nSRE',
            sections: ['Experience'],
            profile: { name: 'Jane Doe', email: 'jane@example.com' },
            jdMustHaves: [],
            groundedTerms: new Set(),
        });
        expect(r.passed).toBe(false);
        expect(r.status).toBe('issues');
        expect(r.issues.join(' ')).toMatch(/Education|Skills/);
    });

    it('returns unverified when text extraction produced nothing', () => {
        const r = buildAtsCheck({
            text: '', sections: [], profile: { name: 'Jane Doe', email: 'jane@example.com' },
            jdMustHaves: [], groundedTerms: new Set(),
        });
        expect(r.machineReadable).toBe(false);
        expect(r.status).toBe('unverified');
        expect(r.passed).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn jest src/ats/checks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `jd-keywords.ts`**

Create `applications/job-strategist/src/ats/jd-keywords.ts`:

```ts
/** @format */
import type { StrategistResearchResult } from '@bedrock/shared';

/** JD must-have terms = hard-requirement skills + infrastructure + tools. */
export function collectJdMustHaves(r: StrategistResearchResult): string[] {
    const out = new Set<string>();
    for (const req of r.hardRequirements) if (req.skill.trim()) out.add(req.skill.trim());
    for (const t of r.technologyInventory.infrastructure) if (t.trim()) out.add(t.trim());
    for (const t of r.technologyInventory.tools) if (t.trim()) out.add(t.trim());
    return [...out];
}

/** Lowercased set of terms with KB evidence (verified or partial matches). */
export function collectGroundedTerms(r: StrategistResearchResult): Set<string> {
    const s = new Set<string>();
    for (const m of r.verifiedMatches) s.add(m.skill.toLowerCase());
    for (const m of r.partialMatches) s.add(m.skill.toLowerCase());
    return s;
}
```

> NOTE: `VerifiedMatch` and `PartialMatch` both expose a `skill: string` field (see `applications/shared/src/strategist-types.ts:260` and `:274`). Confirm the field name when implementing; if it differs, use the actual property — do not invent one.

- [ ] **Step 4: Write `checks.ts`**

Create `applications/job-strategist/src/ats/checks.ts`:

```ts
/** @format */
import type { AtsCheckResult } from './ats-check.schema.js';
import { STANDARD_SECTIONS } from './parse-back.js';

const REQUIRED_SECTIONS = ['Experience', 'Skills', 'Education'] as const;

export interface BuildAtsCheckArgs {
    readonly text: string;
    readonly sections: string[];
    readonly profile: { name: string; email: string };
    readonly jdMustHaves: string[];
    readonly groundedTerms: Set<string>;
}

/** Pure ATS assertions over the parsed-back PDF + structured + JD data. */
export function buildAtsCheck(a: BuildAtsCheckArgs): AtsCheckResult {
    const machineReadable = a.text.trim().length > 0;

    // No usable text → cannot assert anything; fail closed as unverified.
    if (!machineReadable) {
        return {
            machineReadable: false, standardSectionsDetected: [],
            contactDetected: { name: '', email: '' }, parseBreakers: [],
            jdKeywordCoverage: [], status: 'unverified', passed: false,
            issues: ['Rendered PDF produced no extractable text.'],
        };
    }

    const lower = a.text.toLowerCase();
    const standardSectionsDetected = a.sections.filter(s => (STANDARD_SECTIONS as readonly string[]).includes(s));
    const nameFound = a.profile.name.trim().length > 0 && lower.includes(a.profile.name.toLowerCase());
    const emailFound = a.profile.email.trim().length > 0 && lower.includes(a.profile.email.toLowerCase());

    const jdKeywordCoverage = a.jdMustHaves.map(term => ({
        term,
        present:  lower.includes(term.toLowerCase()),
        grounded: a.groundedTerms.has(term.toLowerCase()),
    }));

    // parseBreakers: by construction the layout has none. We still scan for the
    // classic tab-delimited multi-column artifact as a regression guard.
    const parseBreakers: string[] = [];
    if (/\t.+\t/.test(a.text)) parseBreakers.push('multi-column-tabs');

    const issues: string[] = [];
    const missingSections = REQUIRED_SECTIONS.filter(s => !standardSectionsDetected.includes(s));
    if (missingSections.length) issues.push(`Missing standard sections: ${missingSections.join(', ')}.`);
    if (!nameFound) issues.push('Candidate name not found in document body.');
    if (!emailFound) issues.push('Contact email not found in document body.');
    for (const k of jdKeywordCoverage) {
        if (!k.present && k.grounded) issues.push(`Grounded JD must-have "${k.term}" missing from resume.`);
    }
    if (parseBreakers.length) issues.push(`Parse-breaking elements detected: ${parseBreakers.join(', ')}.`);

    const passed = issues.length === 0;
    return {
        machineReadable: true,
        standardSectionsDetected,
        contactDetected: { name: a.profile.name, email: a.profile.email },
        parseBreakers,
        jdKeywordCoverage,
        status: passed ? 'passed' : 'issues',
        passed,
        issues,
    };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd applications/job-strategist && yarn jest src/ats/checks.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 6: Commit**

```bash
git add applications/job-strategist/src/ats/jd-keywords.ts applications/job-strategist/src/ats/checks.ts applications/job-strategist/src/ats/checks.test.ts
git commit -m "feat(ats): JD must-have extraction + ATS parse-back assertions"
```

---

## Task 7: ATS eval grader

**Files:**
- Create: `applications/job-strategist/src/evals/graders/ats-grader.ts`
- Test: `applications/job-strategist/src/evals/graders/ats-grader.test.ts`

Per the repo's non-negotiable per-phase-eval rule, the same checks are exposed as a grader that runs an actual render + parse-back over a generated `StructuredResumeData` and fails when the resume is not ATS-clean.

- [ ] **Step 1: Write the failing test**

Create `applications/job-strategist/src/evals/graders/ats-grader.test.ts`:

```ts
/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { gradeResumeAts } from './ats-grader.js';

const GOOD: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin' },
    summary: 'Platform engineer.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran Kubernetes on AWS.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes', 'AWS'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [], projects: [], keyAchievements: [],
};

describe('gradeResumeAts', () => {
    it('passes a clean resume with grounded JD must-haves present', async () => {
        const res = await gradeResumeAts(GOOD, { jdMustHaves: ['Kubernetes'], groundedTerms: new Set(['kubernetes']) });
        expect(res.pass).toBe(true);
        expect(res.score).toBe(1);
        expect(res.failures).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn jest src/evals/graders/ats-grader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `applications/job-strategist/src/evals/graders/ats-grader.ts`:

```ts
/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { buildAtsCheck } from '../../ats/checks.js';
import { parsePdfBack } from '../../ats/parse-back.js';
import { renderResumePdf } from '../../render/render-resume-pdf.js';

export interface AtsGraderResult { grader: string; pass: boolean; score: number; failures: string[]; }

/** Render → parse-back → assert. The eval-suite QA gate for generated resumes. */
export async function gradeResumeAts(
    data: StructuredResumeData,
    jd: { jdMustHaves: string[]; groundedTerms: Set<string> },
): Promise<AtsGraderResult> {
    const buf = await renderResumePdf(data);
    const { text, sections } = await parsePdfBack(buf);
    const check = buildAtsCheck({
        text, sections,
        profile: { name: data.profile.name, email: data.profile.email },
        jdMustHaves: jd.jdMustHaves, groundedTerms: jd.groundedTerms,
    });
    return { grader: 'ats', pass: check.passed, score: check.passed ? 1 : 0, failures: check.issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn jest src/evals/graders/ats-grader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/evals/graders/ats-grader.ts applications/job-strategist/src/evals/graders/ats-grader.test.ts
git commit -m "feat(ats): ats-grader eval — render+parse-back QA gate for generated resumes"
```

---

## Task 8: Migration + S3/DB artifact storage

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/067_resume_ats_columns.sql`
- Create: `applications/job-strategist/src/ats/store-ats-artifacts.ts`
- Test: `applications/job-strategist/src/ats/store-ats-artifacts.test.ts`

- [ ] **Step 1: Write the migration**

Create `applications/platform-rds-bootstrap/migrations/067_resume_ats_columns.sql`:

```sql
-- 067_resume_ats_columns.sql
-- Adds ATS artifacts to resumes: the canonical text-selectable PDF S3 key and
-- the in-pipeline parse-back check result. Idempotent (ADD COLUMN IF NOT EXISTS),
-- matching the established migration style in this directory.

ALTER TABLE resumes ADD COLUMN IF NOT EXISTS pdf_s3_key    TEXT;
ALTER TABLE resumes ADD COLUMN IF NOT EXISTS ats_check_json JSONB;
```

- [ ] **Step 2: Write the failing test (storage helper, mocked S3 + pg)**

Create `applications/job-strategist/src/ats/store-ats-artifacts.test.ts`:

```ts
/** @format */
import type { AtsCheckResult } from './ats-check.schema.js';
import { storeAtsArtifacts } from './store-ats-artifacts.js';

const CHECK: AtsCheckResult = {
    machineReadable: true, standardSectionsDetected: ['Experience', 'Skills', 'Education'],
    contactDetected: { name: 'Jane Doe', email: 'jane@example.com' }, parseBreakers: [],
    jdKeywordCoverage: [], status: 'passed', passed: true, issues: [],
};

describe('storeAtsArtifacts', () => {
    it('uploads the PDF and updates the resumes row idempotently', async () => {
        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as import('@aws-sdk/client-s3').S3Client;
        const query = jest.fn().mockResolvedValue({ rowCount: 1 });
        const pool = { query } as unknown as import('pg').Pool;

        const key = await storeAtsArtifacts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-1', userId: 'u-1',
            pdf: Buffer.from('%PDF-1.7 test'), check: CHECK,
        });

        expect(key).toBe('resumes/u-1/r-1.pdf');
        expect(put).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledTimes(1);
        const sql = query.mock.calls[0][0] as string;
        expect(sql).toMatch(/UPDATE resumes/i);
        expect(query.mock.calls[0][1]).toEqual(['resumes/u-1/r-1.pdf', JSON.stringify(CHECK), 'r-1']);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn jest src/ats/store-ats-artifacts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write implementation**

Create `applications/job-strategist/src/ats/store-ats-artifacts.ts`:

```ts
/** @format */
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import type { AtsCheckResult } from './ats-check.schema.js';

export interface StoreAtsArtifactsArgs {
    readonly s3:       S3Client;
    readonly pool:     Pool;
    readonly bucket:   string;
    readonly resumeId: string;
    readonly userId:   string;
    readonly pdf:      Buffer;
    readonly check:    AtsCheckResult;
}

/**
 * Upload the canonical PDF to S3 (deterministic key → idempotent on retry) and
 * persist the key + ATS check to the resumes row. The UPDATE is keyed on the
 * resume id created by persistTailoredResume, so re-runs overwrite cleanly.
 */
export async function storeAtsArtifacts(a: StoreAtsArtifactsArgs): Promise<string> {
    const key = `resumes/${a.userId}/${a.resumeId}.pdf`;
    await a.s3.send(new PutObjectCommand({
        Bucket: a.bucket, Key: key, Body: a.pdf, ContentType: 'application/pdf',
    }));
    await a.pool.query(
        `UPDATE resumes SET pdf_s3_key = $1, ats_check_json = $2 WHERE id = $3`,
        [key, JSON.stringify(a.check), a.resumeId],
    );
    return key;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn jest src/ats/store-ats-artifacts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add applications/platform-rds-bootstrap/migrations/067_resume_ats_columns.sql applications/job-strategist/src/ats/store-ats-artifacts.ts applications/job-strategist/src/ats/store-ats-artifacts.test.ts
git commit -m "feat(ats): migration 067 + idempotent S3/DB ATS artifact storage"
```

---

## Task 9: Wire render → check → store into the pipeline

**Files:**
- Modify: `applications/job-strategist/src/run-pipeline.ts:286-298` (after `persistTailoredResume`)
- Modify: `applications/job-strategist/src/run-pipeline.ts` imports (top of file)

The check runs only when a resume was persisted. Failures are fail-open for the *pipeline* (a render/parse error must not fail the whole analysis) but fail-closed for the *claim* (never write `passed` without evidence — `buildAtsCheck` already returns `unverified` on empty text; a thrown render/parse error is caught and recorded as `unverified`).

- [ ] **Step 1: Add imports**

At the top of `applications/job-strategist/src/run-pipeline.ts`, alongside the existing imports, add:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { renderResumePdf } from './render/render-resume-pdf.js';
import { parsePdfBack } from './ats/parse-back.js';
import { buildAtsCheck } from './ats/checks.js';
import { collectJdMustHaves, collectGroundedTerms } from './ats/jd-keywords.js';
import { storeAtsArtifacts } from './ats/store-ats-artifacts.js';
import type { AtsCheckResult } from './ats/ats-check.schema.js';
```

- [ ] **Step 2: Add an S3 client near the module-level singletons**

Find the module-level `obs`/`semanticCache` singletons (around line 50-60) and add:

```ts
/** S3 client for canonical resume PDF storage. */
const s3 = new S3Client({});
```

- [ ] **Step 3: Insert the ATS step after `persisted` is computed**

Immediately after the `const persisted = tailoredResumeData ? await persistTailoredResume(...) : null;` block (ends at `applications/job-strategist/src/run-pipeline.ts:298`), add:

```ts
// ── ATS render + parse-back QA (fail-open pipeline, fail-closed claim) ─────
// Renders the AI-authored resume to a text-selectable PDF, proves it parses,
// and stores the canonical PDF + check. A render/parse error never fails the
// analysis; it is recorded as an 'unverified' check.
if (persisted && tailoredResumeData) {
    const bucket = process.env['ASSETS_BUCKET'] ?? '';
    try {
        const pdf = await renderResumePdf(tailoredResumeData);
        const { text, sections } = await parsePdfBack(pdf);
        const check: AtsCheckResult = buildAtsCheck({
            text, sections,
            profile: { name: tailoredResumeData.profile.name, email: tailoredResumeData.profile.email },
            jdMustHaves:   collectJdMustHaves(research.data),
            groundedTerms: collectGroundedTerms(research.data),
        });
        if (bucket) {
            await storeAtsArtifacts({
                s3, pool, bucket, resumeId: persisted.resumeId, userId: env.userId, pdf, check,
            });
        }
        log.info({
            pipelineRunId: env.pipelineRunId, resumeId: persisted.resumeId,
            atsStatus: check.status, atsIssues: check.issues.length,
        }, 'ATS check complete');
        strategistRuns.inc({ operation: 'analyse', outcome: `ats_${check.status}` });
    } catch (e) {
        log.warn({
            pipelineRunId: env.pipelineRunId, resumeId: persisted.resumeId,
            error: (e as Error).message,
        }, 'ATS render/check failed — recording unverified');
        const unverified: AtsCheckResult = {
            machineReadable: false, standardSectionsDetected: [],
            contactDetected: { name: '', email: '' }, parseBreakers: [],
            jdKeywordCoverage: [], status: 'unverified', passed: false,
            issues: ['ATS render or parse-back failed.'],
        };
        await pool.query(
            `UPDATE resumes SET ats_check_json = $1 WHERE id = $2`,
            [JSON.stringify(unverified), persisted.resumeId],
        ).catch(() => undefined);
        strategistRuns.inc({ operation: 'analyse', outcome: 'ats_error' });
    }
}
```

- [ ] **Step 4: Typecheck + run the unit suite**

Run: `cd applications/job-strategist && yarn typecheck && yarn jest src/ats src/render`
Expected: typecheck clean; all ATS/render unit tests PASS.

- [ ] **Step 5: Run ESLint (project rule — lint before done)**

Run: `cd applications/job-strategist && npx eslint src/run-pipeline.ts src/ats src/render --max-warnings=0`
Expected: no errors. Fix any reported issues before committing.

- [ ] **Step 6: Commit**

```bash
git add applications/job-strategist/src/run-pipeline.ts
git commit -m "feat(ats): wire render+parse-back QA + artifact storage into analyse pipeline"
```

---

## Task 10 (fast-follow — bounded auto-repair)

**Status:** Defined but **not required for P0 to ship.** It extends the Strategist agent's input contract (a `repairHint` that feeds `issues[]` back for one regeneration), which is a riskier change touching `executeStrategistAgent` and the Phase 4 prompt. Implement only after P0 lands and the `ats_${status}` metric shows how often resumes fail the check in practice (data-driven — avoids building remediation for a problem that may be rare).

**Files (when implemented):**
- Modify: `applications/job-strategist/src/agents/strategist-agent.ts` (accept optional `repairHint?: string[]`)
- Modify: `applications/job-strategist/src/run-pipeline.ts` (in the `catch`/`status==='issues'` branch: if `check.status === 'issues'` and a repair has not yet run, call the Strategist once more with `repairHint: check.issues`, re-render, re-check, then store the better of the two)

- [ ] **Step 1:** Read `executeStrategistAgent`'s signature and Phase 4 prompt assembly before writing any code (the input contract is not yet known to this plan).
- [ ] **Step 2:** Add a per-phase eval asserting a resume that initially fails on a missing grounded must-have passes after one repair.
- [ ] **Step 3:** Cap repairs at 1; persist the post-repair check; emit an `ats_repaired` metric.

---

## Self-review notes

- **Spec coverage:** §2 architecture → Tasks 1-3, 9. §3 ATSCheckResult → Tasks 5-6. §4 QA loop (detect/report) → Tasks 6, 9; (auto-repair) → Task 10. §5 components → all tasks. §7 error handling → Task 9 (fail-open pipeline / fail-closed claim) + Task 8 (idempotent storage). §8 evals → Task 7. Migration → Task 8.
- **P1/P2 deferred by design:** DOCX, recruiter-blurb summary, JD-term prompt strengthening, frontend checklist UI, and Affinda calibration are out of this plan and will each get their own plan.
- **Type consistency:** `AtsCheckResult` shape is identical across schema (Task 5), checks (Task 6), grader (Task 7), storage (Task 8), pipeline (Task 9). `renderResumePdf` / `parsePdfBack` / `buildAtsCheck` signatures match every call site.
- **Open verification for the implementer:** (a) confirm `VerifiedMatch.skill` / `PartialMatch.skill` field names; (b) confirm the resume PDF bucket env var is `ASSETS_BUCKET` (validated in `environment.schema.ts`) vs `S3_BUCKET` used elsewhere in `run-pipeline.ts` — use whichever the analyse job actually receives; (c) confirm `tsconfig` preserves dynamic `import()` for the ESM react-pdf load.
