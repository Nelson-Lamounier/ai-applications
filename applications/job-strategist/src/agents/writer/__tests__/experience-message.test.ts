/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildExperienceMessage } from '../experience-message.js';

const research = {
  targetRole: 'Technical Services Engineer', targetCompany: 'MongoDB', fitSummary: 'Solid fit.',
  verifiedMatches: [{ skill: 'DNS', sourceCitation: 'infra/dns.ts', depth: 'expert', recency: 'current', evidenceFiles: ['infra/dns.ts'] }],
  partialMatches: [], gaps: [],
} as never;
const base = {
  research,
  roster: [{ company: 'AWS', title: 'Support Engineer', period: '2023-2025' }],
  careerLines: [{ id: 'c0.h0', roleIndex: 0, text: 'Configured VPC networking and Route53 DNS' }],
  atsTargets: [{ skill: 'DNS', source: 'disqualifying' as const, verdict: 'verified' as const, requirement: 'Networking concepts and protocols (DNS, TCP/IP, SSL/TLS)' }],
  groundedMetrics: '- cut MTTR by 30% (runbooks/incident.md)',
  codeStack: 'Current: EKS, Terraform',
};

describe('buildExperienceMessage', () => {
  it('emits indexed career lines under the accounting contract', () => {
    const msg = buildExperienceMessage(base);
    expect(msg).toContain('[c0.h0] Configured VPC networking and Route53 DNS');
    expect(msg).toContain('## Career History');
    expect(msg).toContain('accounted for');
  });
  it('groups ATS targets under their JD requirement', () => {
    const msg = buildExperienceMessage(base);
    expect(msg).toContain('Networking concepts and protocols (DNS, TCP/IP, SSL/TLS)');
    expect(msg).toContain('- DNS (verified)');
  });
  it('includes metrics and code stack; omits empty sections', () => {
    const msg = buildExperienceMessage(base);
    expect(msg).toContain('## Grounded Metrics');
    expect(msg).toContain('cut MTTR by 30%');
    const bare = buildExperienceMessage({ ...base, groundedMetrics: '', codeStack: '', atsTargets: [] });
    expect(bare).not.toContain('## Grounded Metrics');
    expect(bare).not.toContain('## ATS Targets');
  });
  it('adds the re-write block only on the re-write pass', () => {
    expect(buildExperienceMessage(base)).not.toContain('## Re-write pass');
    const rw = buildExperienceMessage({ ...base, rewriteDraft: 'AWS | Support Engineer\n- old bullet', rewriteMissing: ['TCP/IP'] });
    expect(rw).toContain('## Re-write pass');
    expect(rw).toContain('TCP/IP');
  });
});
