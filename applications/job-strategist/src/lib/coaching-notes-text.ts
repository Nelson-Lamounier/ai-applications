/** @format */

/**
 * Flatten structured (or legacy string) `coachingNotes` into located text
 * fragments, so the prose linter and grounding extractor keep covering every
 * section after the field became an object. A bare string (legacy rows / model
 * slip) is returned as a single `coachingNotes` fragment.
 */
export interface CoachingNotesFragment {
    readonly location: string;
    readonly text: string;
}

const STRING_FIELDS = ['positioning', 'tacticalPrep', 'communication', 'mindset', 'debrief'] as const;

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
    if (notes === null || typeof notes !== 'object') return out;

    const n = notes as Record<string, unknown>;
    for (const key of STRING_FIELDS) {
        pushFragment(out, `coachingNotes.${key}`, n[key]);
    }
    const focus = n['interviewFocus'];
    if (Array.isArray(focus)) {
        focus.forEach((item, i) => {
            if (item !== null && typeof item === 'object') {
                pushFragment(out, `coachingNotes.interviewFocus[${i}].detail`, (item as Record<string, unknown>)['detail']);
            }
        });
    }
    // finalCheckpoint is a structured object { items, note }; a legacy string also handled.
    const checkpoint = n['finalCheckpoint'];
    if (typeof checkpoint === 'string') {
        pushFragment(out, 'coachingNotes.finalCheckpoint', checkpoint);
    } else if (checkpoint !== null && typeof checkpoint === 'object') {
        const fc = checkpoint as Record<string, unknown>;
        pushFragment(out, 'coachingNotes.finalCheckpoint.note', fc['note']);
        const items = fc['items'];
        if (Array.isArray(items)) {
            items.forEach((it, i) => pushFragment(out, `coachingNotes.finalCheckpoint.items[${i}]`, it));
        }
    }
    return out;
}
