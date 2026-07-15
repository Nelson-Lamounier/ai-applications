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
  atsTargets: [{
    skill: 'DNS', source: 'disqualifying' as const, verdict: 'verified' as const,
    requirement: 'Networking concepts and protocols (DNS, TCP/IP, SSL/TLS)', anchors: ['c0.h0'],
  }],
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
    expect(msg).toContain('TARGET: DNS (verified)');
  });
  it('grounds an anchored target with its career-line id and text', () => {
    const msg = buildExperienceMessage(base);
    expect(msg).toContain('grounded by [c0.h0] "Configured VPC networking and Route53 DNS"');
  });
  it('names a zero-anchor target as honestly unsupported, never fabricating a citation', () => {
    const unanchored = {
      ...base,
      atsTargets: [{
        skill: 'Kubernetes', source: 'hard' as const, verdict: 'verified' as const,
        requirement: 'Kubernetes', anchors: [] as string[],
      }],
    };
    const msg = buildExperienceMessage(unanchored);
    expect(msg).toContain('TARGET: Kubernetes (verified) -- no career line names this');
    expect(msg).toContain('leave it as a reported gap');
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
  it('adds the jd-echo cleanup block only when flagged details are present, under its own heading', () => {
    expect(buildExperienceMessage(base)).not.toContain('## JD-Echo Cleanup');
    const cleanup = buildExperienceMessage({
      ...base,
      echoCleanup: { flaggedDetails: ['AWS: "Applied DNS resolution..." leans on JD vocabulary (foo, bar) absent from this role\'s verified facts.'] },
    });
    expect(cleanup).toContain('## JD-Echo Cleanup');
    expect(cleanup).toContain('AWS: "Applied DNS resolution');
    expect(cleanup).toContain('Rephrase EACH flagged bullet');
    expect(cleanup).not.toContain('## Re-write pass');
  });
  it('omits the jd-echo cleanup block when flaggedDetails is empty', () => {
    const empty = buildExperienceMessage({ ...base, echoCleanup: { flaggedDetails: [] } });
    expect(empty).not.toContain('## JD-Echo Cleanup');
  });
  it('adds the verb-alignment block only when findings are present, under its own heading', () => {
    expect(buildExperienceMessage(base)).not.toContain('## Verb Alignment');
    const withFindings = buildExperienceMessage({
      ...base,
      verbAlignment: { findings: [{ bulletText: 'Owned end-to-end technical resolution', verb: 'own', supported: 'assist/support' }] },
    });
    expect(withFindings).toContain('## Verb Alignment');
    expect(withFindings).toContain('align each lead verb to what the cited lines support');
    expect(withFindings).toContain('never weaken a verb the evidence does support');
    expect(withFindings).toContain('Owned end-to-end technical resolution');
    expect(withFindings).not.toContain('## JD-Echo Cleanup');
  });
  it('omits the verb-alignment block when findings is empty', () => {
    const empty = buildExperienceMessage({ ...base, verbAlignment: { findings: [] } });
    expect(empty).not.toContain('## Verb Alignment');
  });
});
