/** @format */

/**
 * Flatten `coachingNotes` into located text fragments, so the prose linter keeps
 * covering every section now that the field is an array of `{ key, title, body,
 * checklist? }` sections. A bare string (legacy rows / model slip) is returned as
 * a single `coachingNotes` fragment.
 */
export interface CoachingNotesFragment {
    readonly location: string;
    readonly text: string;
}

function pushFragment(out: CoachingNotesFragment[], location: string, value: unknown): void {
    if (typeof value === 'string' && value.trim().length > 0) {
        out.push({ location, text: value.trim() });
    }
}

export function coachingNotesFragments(notes: unknown): CoachingNotesFragment[] {
    const out: CoachingNotesFragment[] = [];
    if (typeof notes === 'string') {
        pushFragment(out, 'coachingNotes', notes);
        return out;
    }
    if (!Array.isArray(notes)) return out;

    notes.forEach((section, i) => {
        if (section === null || typeof section !== 'object') return;
        const s = section as Record<string, unknown>;
        pushFragment(out, `coachingNotes[${i}].body`, s['body']);
        const checklist = s['checklist'];
        if (Array.isArray(checklist)) {
            checklist.forEach((item, j) => pushFragment(out, `coachingNotes[${i}].checklist[${j}]`, item));
        }
    });
    return out;
}
