/** @format */
/**
 * Replace em-dashes (U+2014 "—") — a strong AI-tell when overused — with commas.
 * PRESERVES en-dashes (U+2013 "–", used in date ranges like 2021–2024) and the
 * middot (·, used in the positioning headline). Deterministic; safe on any prose field.
 */
export function normalizeProse(text: string): string {
    if (!text) return text;
    return text
        .replace(/\s*—\s*/g, ', ')       // em-dash (spaced or not) -> comma
        .replace(/\s+,/g, ',')            // " ," -> ","
        .replace(/,\s*,/g, ',')           // ",," -> ","
        .replace(/,\s*([.;:!?])/g, '$1') // ", ." -> "." etc.
        .replace(/[ \t]{2,}/g, ' ');      // collapse space runs
}
