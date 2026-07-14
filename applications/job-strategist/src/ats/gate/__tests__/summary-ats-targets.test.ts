/** @format */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from '@jest/globals';
import { selectSummaryAtsTargets } from '../summary-ats-targets.js';

const ledger = [
  { tool: 'Kubernetes', status: 'verified', evidenceFiles: [], evidence: '', transferableBridge: '' },
  { tool: 'Terraform',  status: 'transferable', evidenceFiles: [], evidence: '', transferableBridge: '' },
  { tool: 'Go',         status: 'gap', evidenceFiles: [], evidence: '', transferableBridge: '' },
  { tool: 'AWS',        status: 'verified', evidenceFiles: [], evidence: '', transferableBridge: '' },
] as any;
const jd = { hardRequirements: [
  { skill: 'Kubernetes', disqualifying: true },
  { skill: 'AWS', disqualifying: false },
  { skill: 'Terraform' },
  { skill: 'Go', disqualifying: true },
] };

describe('selectSummaryAtsTargets', () => {
  it('excludes gaps, orders disqualifying-first, caps at 3', () => {
    const t = selectSummaryAtsTargets(ledger, jd, 3);
    expect(t.map((x) => x.skill)).toEqual(['Kubernetes', 'AWS', 'Terraform']);
    expect(t.every((x) => x.verdict !== undefined)).toBe(true);
    expect(t.find((x) => x.skill === 'Go')).toBeUndefined();
  });
  it('returns [] when no attainable JD must-have exists', () => {
    expect(selectSummaryAtsTargets([{ tool: 'Rust', status: 'gap' } as any], jd, 3)).toEqual([]);
  });
});
