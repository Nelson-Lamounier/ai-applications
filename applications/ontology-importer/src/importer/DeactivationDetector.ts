/** @format */
/** N-consecutive-miss deactivation policy. */
export function shouldDeactivate(consecutiveMisses: number, threshold = 3): boolean {
    return consecutiveMisses >= threshold;
}
