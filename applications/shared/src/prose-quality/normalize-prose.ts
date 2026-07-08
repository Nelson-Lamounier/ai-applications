/** @format */
/**
 * Replace em-dashes (U+2014 "—") — a strong AI-tell when overused — with commas.
 * PRESERVES en-dashes (U+2013 "–", used in date ranges like 2021–2024) and the
 * middot (·, used in the positioning headline). Deterministic; safe on any prose field.
 */
export function normalizeProse(text: string): string {
    if (!text) return text;
    return text
        .replace(/≥\s*/g, 'at least ')    // "≥42%" -> "at least 42%" (breaks PDF fonts/ATS parsers)
        .replace(/≤\s*/g, 'at most ')     // "≤100 ms" -> "at most 100 ms"
        .replace(/\s*→\s*/g, ' to ')      // "0.368 → 0.673" -> "0.368 to 0.673"
        .replace(/(\d+(?:\.\d+)?)\+(?!\+)/g, 'more than $1') // "265+" -> "more than 265"; C++ untouched
        .replace(/\s*—\s*/g, ', ')       // em-dash (spaced or not) -> comma
        .replace(/\s+,/g, ',')            // " ," -> ","
        .replace(/,\s*,/g, ',')           // ",," -> ","
        .replace(/,\s*([.;:!?])/g, '$1') // ", ." -> "." etc.
        .replace(/[ \t]{2,}/g, ' ');      // collapse space runs
}
