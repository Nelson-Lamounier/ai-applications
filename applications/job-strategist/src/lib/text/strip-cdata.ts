/** @format */

/**
 * Strip an XML CDATA wrapper that the model occasionally bleeds into free-text
 * string fields (e.g. `coachingNotes`). The Bedrock prompt uses XML-tagged
 * sections, and the model sometimes echoes a `<![CDATA[ … ]]>` envelope around
 * long Markdown values, which then renders literally in the UI.
 *
 * Only a *complete* wrapper is removed — the string must start with the opening
 * delimiter and end with the closing one. A stray `<![CDATA[` or `]]>` elsewhere
 * in the text is left untouched. Inner whitespace is trimmed so the leading
 * newline the model adds after `<![CDATA[` does not survive.
 */
const CDATA_WRAPPER = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/;

export function stripCdata(value: string): string {
    const match = CDATA_WRAPPER.exec(value);
    if (!match) return value;
    return match[1].trim();
}

/**
 * Recursively apply {@link stripCdata} to every string in a JSON-like value
 * (object, array, or primitive). Non-string primitives and `null` pass through
 * unchanged. Used as a safety-net over the whole parsed Coach result so a CDATA
 * leak in any field is normalised before persistence.
 */
export function deepStripCdata<T>(value: T): T {
    if (typeof value === 'string') return stripCdata(value) as T;
    if (Array.isArray(value)) return value.map(deepStripCdata) as T;
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = deepStripCdata(val);
        }
        return out as T;
    }
    return value;
}
