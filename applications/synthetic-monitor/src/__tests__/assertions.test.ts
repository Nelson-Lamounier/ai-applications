/**
 * @format
 * Unit tests for the synthetic monitor's pure decision logic. This is the part
 * that decides "the dashboard reflects reality", so it is exhaustively tested.
 */
import { describe, it, expect } from '@jest/globals';
import {
  sumVector, seriesCount, deltaAtLeast, hasNoDoubleScrape, durationRecorded,
  type PromVectorResponse,
} from '../assertions.js';

const vec = (...samples: [Record<string, string>, string][]): PromVectorResponse => ({
  status: 'success',
  data: { resultType: 'vector', result: samples.map(([metric, v]) => ({ metric, value: [0, v] })) },
});
const empty: PromVectorResponse = { status: 'success', data: { resultType: 'vector', result: [] } };
const errored: PromVectorResponse = { status: 'error', data: { resultType: 'vector', result: [] } };

describe('sumVector', () => {
  it('sums all series values', () => {
    expect(sumVector(vec([{}, '2'], [{}, '3.5']))).toBe(5.5);
  });
  it('returns null for empty or errored responses', () => {
    expect(sumVector(empty)).toBeNull();
    expect(sumVector(errored)).toBeNull();
  });
});

describe('seriesCount', () => {
  it('counts series, 0 on error', () => {
    expect(seriesCount(vec([{}, '1'], [{}, '1']))).toBe(2);
    expect(seriesCount(errored)).toBe(0);
  });
});

describe('deltaAtLeast', () => {
  it('treats a null baseline as 0', () => {
    expect(deltaAtLeast(null, 1, 1)).toBe(true);
  });
  it('requires the minimum delta', () => {
    expect(deltaAtLeast(60, 61, 1)).toBe(true);
    expect(deltaAtLeast(60, 60, 1)).toBe(false);
  });
  it('is false when after is null (metric vanished)', () => {
    expect(deltaAtLeast(60, null, 1)).toBe(false);
  });
});

describe('hasNoDoubleScrape', () => {
  it('passes when no exported_instance series exist', () => {
    expect(hasNoDoubleScrape(empty)).toBe(true);
  });
  it('fails when a double-scraped series is present', () => {
    expect(hasNoDoubleScrape(vec([{ exported_instance: 'abc' }, '1']))).toBe(false);
  });
});

describe('durationRecorded', () => {
  it('passes only when the histogram sum is positive', () => {
    expect(durationRecorded(vec([{}, '12.5']))).toBe(true);
    expect(durationRecorded(vec([{}, '0']))).toBe(false); // seeded-but-never-observed bug
    expect(durationRecorded(empty)).toBe(false);
  });
});
