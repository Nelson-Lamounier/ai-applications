/**
 * @format
 * Grounding-fidelity rules: experience bullets must restate the ingested
 * career facts, project descriptions must open on their documented pitch, and
 * bullets must not lean on JD vocabulary absent from the employer's record.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import type { ResumeViolation, VerifiedEmployer } from './types.js';
import { distinctiveTokens, stemmedTokens } from './text.js';

/**
 * Experience fidelity — bullets for an employer must RESTATE work the
 * ingested career-history facts describe; JD-tailoring is rephrasing and
 * emphasis, never new deeds or a new domain. Observed live (Meta via
 * Accenture): the ingested facts describe ads-platform operations, but
 * generated bullets claimed "content moderation workflows" (world-knowledge
 * stereotype) and, on another run, invented test-strategy/quality-gate design
 * work. Deterministic: an entry whose bullets share fewer than 2 distinctive
 * tokens with its employer's verified facts is flagged for a grounded rewrite.
 */
type LooseExperienceEntry = { company?: unknown; highlights?: readonly unknown[] };

/** Violation for one entry, or null when grounded / not matchable. */
function entryFidelityViolation(
    entry: LooseExperienceEntry,
    verifiedEmployers: ReadonlyArray<VerifiedEmployer>,
): ResumeViolation | null {
    const company = typeof entry.company === 'string' ? entry.company : '';
    if (!company) return null;
    const employer = verifiedEmployers.find((e) =>
        e.name.toLowerCase().includes(company.toLowerCase()) || company.toLowerCase().includes(e.name.toLowerCase()));
    if (!employer) return null;
    const bulletText = (entry.highlights ?? []).filter((h): h is string => typeof h === 'string').join(' ');
    if (bulletText.length === 0) return null;
    const factTokens = distinctiveTokens(employer.facts);
    let overlap = 0;
    for (const t of distinctiveTokens(bulletText)) if (factTokens.has(t)) overlap++;
    if (overlap >= 2) return null;
    return {
        code: 'experience_ungrounded',
        detail: `${company}: bullets share ${overlap} distinctive terms with the ingested career facts - the work described is not the work on record.`,
    };
}

/** Loose project<->pitch name match (case/punctuation-insensitive containment). */
function pitchForProject(
    name: string,
    pitches: ReadonlyArray<{ name: string; pitch: string }>,
): { name: string; pitch: string } | undefined {
    const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const n = norm(name);
    return pitches.find((p) => n.includes(norm(p.name)) || norm(p.name).includes(n));
}

/** Overlap ratio of the description's opening with the documented pitch. */
const PITCH_OPENING_CHARS = 220;
const PITCH_MIN_OVERLAP = 0.3;

/**
 * Project descriptions must OPEN on the documented pitch (what it is, who it
 * is for, the problem it solves) — the persona's three-beat rule. Run
 * 048379a3 (2026-07-08) shipped 42-word stack-dump descriptions that ignored
 * the pitch entirely and nothing flagged them: the only project check was
 * reactive (bullet-number restating). Deterministic; the guard rewrite
 * repairs flagged projects using the pitch it already receives.
 */
type ResumeProject = StructuredResumeData['projects'][number];

/** Violation for one project's opening vs its documented pitch, or null. */
function projectPitchViolation(
    p: ResumeProject,
    pitches: ReadonlyArray<{ name: string; pitch: string }>,
): ResumeViolation | null {
    const pitch = typeof p.description === 'string' ? pitchForProject(p.name ?? '', pitches) : undefined;
    if (!pitch) return null;
    const pitchTokens = stemmedTokens(pitch.pitch);
    if (pitchTokens.size === 0) return null;
    const opening = stemmedTokens(p.description.slice(0, PITCH_OPENING_CHARS));
    let hit = 0;
    for (const t of pitchTokens) if (opening.has(t)) hit++;
    if (hit / pitchTokens.size >= PITCH_MIN_OVERLAP) return null;
    return {
        code: 'project_pitch_missing',
        detail: `${p.name}: description does not open on the documented pitch (${hit}/${pitchTokens.size} pitch terms in the opening).`,
    };
}

export function checkProjectPitchAlignment(
    resume: StructuredResumeData,
    pitches: ReadonlyArray<{ name: string; pitch: string }> | undefined,
): ResumeViolation[] {
    if (!pitches || pitches.length === 0) return [];
    return (resume.projects ?? [])
        .map((p) => projectPitchViolation(p, pitches))
        .filter((v): v is ResumeViolation => v !== null);
}

/**
 * Bullet-level JD-echo fidelity — the fabrication mechanism observed live on
 * run 048379a3: under tailoring pressure the writer builds a career bullet
 * from JD vocabulary ("Configured enterprise platform deployments" on a QA
 * role) while enough honest paraphrase surrounds it to pass the ENTRY-level
 * overlap check. A bullet on a verified employer that leans on 2+ JD terms
 * absent from that employer's facts is flagged for a grounded rewrite.
 */
/** JD-echo violations for one career entry's bullets. */
function entryJdEchoViolations(
    entry: LooseExperienceEntry,
    verifiedEmployers: ReadonlyArray<VerifiedEmployer>,
    jdTokens: ReadonlySet<string>,
): ResumeViolation[] {
    const company = typeof entry.company === 'string' ? entry.company : '';
    const employer = verifiedEmployers.find((e) =>
        e.name.toLowerCase().includes(company.toLowerCase()) || company.toLowerCase().includes(e.name.toLowerCase()));
    if (!company || !employer) return [];
    const factTokens = stemmedTokens(employer.facts);
    const out: ResumeViolation[] = [];
    for (const bullet of (entry.highlights ?? []).filter((h): h is string => typeof h === 'string')) {
        const echo = [...stemmedTokens(bullet)].filter((t) => jdTokens.has(t) && !factTokens.has(t));
        if (echo.length >= 2) {
            out.push({
                code: 'experience_bullet_jd_echo',
                detail: `${company}: "${bullet.slice(0, 90)}" leans on JD vocabulary (${echo.slice(0, 4).join(', ')}) absent from this role's verified facts.`,
            });
        }
    }
    return out;
}

export function checkBulletJdEcho(
    resume: StructuredResumeData,
    verifiedEmployers: ReadonlyArray<VerifiedEmployer> | undefined,
    jdText: string,
): ResumeViolation[] {
    if (!verifiedEmployers || verifiedEmployers.length === 0 || !jdText.trim()) return [];
    const jdTokens = stemmedTokens(jdText);
    const view = resume as unknown as { experience?: ReadonlyArray<LooseExperienceEntry> };
    return (view.experience ?? []).flatMap((entry) => entryJdEchoViolations(entry, verifiedEmployers, jdTokens));
}

export function checkExperienceFidelity(
    resume: StructuredResumeData,
    verifiedEmployers: ReadonlyArray<VerifiedEmployer> | undefined,
): ResumeViolation[] {
    if (!verifiedEmployers || verifiedEmployers.length === 0) return [];
    const view = resume as unknown as { experience?: ReadonlyArray<LooseExperienceEntry> };
    return (view.experience ?? [])
        .map((entry) => entryFidelityViolation(entry, verifiedEmployers))
        .filter((v): v is ResumeViolation => v !== null);
}
