/** @format */
import { describe, it, expect } from '@jest/globals';
import { selectExperienceAtsTargets } from '../experience-ats-targets.js';
import { indexCareerLines } from '../../../agents/writer/experience-provenance.js';

const entry = (tool: string, status: string) =>
  ({ tool, status, evidenceFiles: [], evidence: '', transferableBridge: '' });
const ledger = [
  entry('DNS', 'verified'), entry('TCP/IP', 'verified'), entry('SSL/TLS', 'transferable'),
  entry('Kubernetes', 'verified'), entry('Go', 'gap'), entry('AWS', 'verified'),
  entry('Terraform', 'transferable'), entry('Python', 'verified'),
] as never;
const NETWORKING = 'Networking concepts and protocols (DNS, TCP/IP, SSL/TLS, etc)';
const jd = { hardRequirements: [
  { skill: NETWORKING, context: '', disqualifying: true },
  { skill: 'Kubernetes', context: '' },
  { skill: 'Go', context: '', disqualifying: true },
  { skill: 'AWS', context: '' },
  { skill: 'Terraform', context: '' },
  { skill: 'Python', context: '' },
] };
const careerEntries = [
  { title: 'Support Engineer', company: 'AWS', period: '2023-2025', highlights: [
    'Configured VPC networking and Route53 DNS records',
    'Ran Kubernetes clusters on EKS with Terraform-managed infra',
  ] },
] as never;
const careerLines = indexCareerLines(careerEntries);

describe('selectExperienceAtsTargets', () => {
  it('matches composite requirements member-by-member and stamps the requirement text', () => {
    const t = selectExperienceAtsTargets(ledger, jd, careerLines, 6);
    const net = t.filter((x) => x.requirement === NETWORKING).map((x) => x.skill);
    expect(net).toEqual(expect.arrayContaining(['DNS', 'TCP/IP', 'SSL/TLS']));
    expect(t.find((x) => x.skill === 'Go')).toBeUndefined(); // gap excluded
  });
  it('orders disqualifying first, verified before transferable, caps at limit', () => {
    const t = selectExperienceAtsTargets(ledger, jd, careerLines, 6);
    expect(t).toHaveLength(6);
    expect(t[0]?.source).toBe('disqualifying');
    const first = t.findIndex((x) => x.verdict === 'transferable');
    const lastVerifiedSameSource = t.filter((x) => x.source === t[Math.max(first, 0)]?.source && x.verdict === 'verified');
    expect(first === -1 || lastVerifiedSameSource.every((x) => t.indexOf(x) < first || t[first] === undefined || t[first].source !== x.source)).toBe(true);
  });
  it('returns [] when nothing attainable matches', () => {
    expect(selectExperienceAtsTargets([entry('Rust', 'gap')] as never, jd, careerLines, 6)).toEqual([]);
  });

  describe('anchors (LIVE RUN CASE 5: anchor computation returns matching c-ids)', () => {
    it('stamps DNS with the career line that names it', () => {
      const t = selectExperienceAtsTargets(ledger, jd, careerLines, 6);
      const dns = t.find((x) => x.skill === 'DNS');
      expect(dns?.anchors).toEqual(['c0.h0']);
    });
    it('stamps Kubernetes with the career line that names it, not the DNS line', () => {
      const t = selectExperienceAtsTargets(ledger, jd, careerLines, 6);
      const k8s = t.find((x) => x.skill === 'Kubernetes');
      expect(k8s?.anchors).toEqual(['c0.h1']);
    });
    it('leaves anchors empty when no career line term-matches the target', () => {
      const t = selectExperienceAtsTargets(ledger, jd, careerLines, 6);
      const py = t.find((x) => x.skill === 'Python');
      expect(py?.anchors).toEqual([]);
    });
  });
});
