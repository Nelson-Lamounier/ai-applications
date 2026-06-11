/** @format */

export interface YearInterval { startYear: number; endYear: number; }

/** Parse a free-form period to a year interval. `Present`/`Current` → nowYear. */
export function parsePeriod(period: string, nowYear: number): YearInterval | null {
    const parts = period.split(/[-–—]/);
    if (parts.length < 2) return null;
    const startYear = firstYear(parts[0]);
    const endRaw = parts.slice(1).join('-');
    const endYear = /present|current/i.test(endRaw) ? nowYear : firstYear(endRaw);
    if (startYear === null || endYear === null || endYear < startYear) return null;
    return { startYear, endYear };
}

function firstYear(s: string): number | null {
    const m = /(19|20)\d{2}/.exec(s);
    return m ? Number.parseInt(m[0], 10) : null;
}

/** Merge overlapping intervals, sum the merged lengths, round to 1 decimal. */
export function unionYears(intervals: YearInterval[]): number {
    if (intervals.length === 0) return 0;
    const sorted = [...intervals].sort((a, b) => a.startYear - b.startYear);
    let total = 0;
    let curStart = sorted[0].startYear;
    let curEnd = sorted[0].endYear;
    for (let i = 1; i < sorted.length; i++) {
        const iv = sorted[i];
        if (iv.startYear <= curEnd) {
            if (iv.endYear > curEnd) curEnd = iv.endYear;
        } else {
            total += curEnd - curStart;
            curStart = iv.startYear;
            curEnd = iv.endYear;
        }
    }
    total += curEnd - curStart;
    return Math.round(total * 10) / 10;
}

/** Parse the JD's expected years to the floor the candidate must clear. */
export function parseRequiredYears(yearsExpected: string): number | null {
    const m = /(\d{1,2})/.exec(yearsExpected);
    return m ? Number.parseInt(m[1], 10) : null;
}
