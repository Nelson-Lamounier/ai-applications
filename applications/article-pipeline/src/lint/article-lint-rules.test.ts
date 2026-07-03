/**
 * article-lint-rules.test.ts
 *
 * Each test uses a fragment taken from (or modelled on) the actual EKS
 * platform article, so the suite doubles as a regression record of the
 * defects found in the 2026-06-20 review.
 */
import { describe, it, expect } from '@jest/globals';
import {
  checkTitleCoverage,
  checkCrossSectionDuplicates,
  checkSlopConstructions,
  checkEmDashDensity,
  checkDanglingReferences,
  checkNoManualToc,
  checkLinkShape,
  checkIdentifierLeaks,
  checkEnumeratedGeneralisations,
  checkHeadingExpressions,
  checkReadability,
} from './article-lint-rules.js';

describe('title-coverage (the Golden Path bug)', () => {
  it('fails when a title term never appears in the body', () => {
    const src = '## Intro\nWe built a platform with GitOps and Pod Identity.';
    const findings = checkTitleCoverage(src, {
      title: 'GitOps, Pod Identity, and the Golden Path',
    });
    const golden = findings.find((f) => f.message.includes('"golden"'));
    expect(golden?.severity).toBe('error');
  });

  it('passes when every title concept is developed', () => {
    const src =
      '## The Golden Path\nThe golden path is the paved road. ' +
      'A golden path means teams adopt defaults.\n' +
      'GitOps GitOps identity identity path path';
    const findings = checkTitleCoverage(src, {
      title: 'GitOps and the Golden Path',
    });
    expect(findings).toHaveLength(0);
  });
});

describe('cross-section-duplicate (triple-stated IMDS fix)', () => {
  it('flags a distinctive phrase repeated in two sections', () => {
    const phrase =
      'the default hop limit of one drops IMDS responses at the bridge';
    const src = `## Challenges\n${phrase}.\n## Junior Corner\nRemember: ${phrase}.`;
    const findings = checkCrossSectionDuplicates(src);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe('error');
  });

  it('ignores repetition within the same section', () => {
    const phrase = 'sync waves are a contract not a sequencing hint';
    const src = `## GitOps\n${phrase}. Again: ${phrase}.`;
    expect(checkCrossSectionDuplicates(src)).toHaveLength(0);
  });
});

describe('slop constructions', () => {
  it('flags not-just-X-but-Y reframes', () => {
    const src =
      '## A\nThis is not just organisational tidiness — it is operationally essential.';
    const f = checkSlopConstructions(src);
    expect(f.some((x) => x.rule === 'slop:not-just-x-but-y')).toBe(true);
  });

  it('flags negation pairs beyond the allowance', () => {
    const src =
      '## A\nNode capacity is two-tier by design, not by accident. ' +
      'Sync waves are a contract, not a hint. It is a decision, not a default.';
    const f = checkSlopConstructions(src);
    expect(f.some((x) => x.rule === 'slop:negation-pair')).toBe(true);
  });
});

describe('em-dash density', () => {
  it('warns when em-dashes exceed one per paragraph on average', () => {
    const para =
      'The split is deliberate — CDK provisions the substrate — and the ' +
      'bootstrap repo — the GitOps source — owns the rest of it entirely.';
    const src = `## A\n${para}\n\n${para}\n\n${para}`;
    expect(checkEmDashDensity(src)).toHaveLength(1);
  });
});

describe('readability (Flesch)', () => {
  it('warns on jargon-dense prose below the floor', () => {
    const dense =
      'The deterministic provenance reconciliation subsystem instruments ' +
      'probabilistic hallucination remediation through hierarchical ' +
      'observability orchestration. Instrumentation asymmetry necessitates ' +
      'comprehensive verification methodologies across heterogeneous ' +
      'infrastructure abstractions continuously. Orchestration architecture ' +
      'demonstrates considerable computational sophistication throughout ' +
      'distributed remediation pipelines everywhere.';
    expect(checkReadability(dense)).toHaveLength(1);
  });

  it('passes plain prose', () => {
    const plain =
      'The guard runs after the model. It checks each claim. If a number is ' +
      'not in the source, it strips it out. The code is small and easy to read.';
    expect(checkReadability(plain)).toHaveLength(0);
  });

  it('skips short fragments', () => {
    expect(checkReadability('Too short to score.')).toHaveLength(0);
  });
});

describe('dangling references', () => {
  it('flags parenthetical caveat name-drops', () => {
    const src =
      '## Apply\nPod Identity for Bedrock invocation (with the eu-west-1 ' +
      'cross-region inference profile caveat), PgBouncer for pooling.';
    const f = checkDanglingReferences(src);
    expect(f.some((x) => x.rule === 'dangling-reference')).toBe(true);
  });
});

describe('manual TOC ban', () => {
  it('flags a hand-written table of contents', () => {
    const src =
      '## Table of Contents\n\n' +
      '- [The Problem](#the-problem)\n' +
      '- [Architecture](#architecture)\n' +
      '- [Challenges](#challenges)\n';
    const f = checkNoManualToc(src);
    expect(f[0]?.severity).toBe('error');
  });
});

describe('link shape', () => {
  it('flags homepage links as shallow', () => {
    const src = "See [Karpenter's documentation](https://karpenter.sh/).";
    const f = checkLinkShape(src);
    expect(f.some((x) => x.rule === 'shallow-link')).toBe(true);
  });

  it('accepts deep documentation links', () => {
    const src =
      'See [metadataOptions](https://karpenter.sh/docs/concepts/nodeclasses/#specmetadataoptions).';
    const f = checkLinkShape(src);
    expect(f.some((x) => x.rule === 'shallow-link')).toBe(false);
  });
});

describe('identifier leaks', () => {
  it('flags SSM paths, association IDs, and KB verification metadata', () => {
    const src =
      'ARN stored at /k8s/development/eks/waf-annotator-pod-identity-arn. ' +
      'Association a-k6n3obam7g4zgjht7 already existed. ' +
      'Verified active 2026-06-16.';
    const f = checkIdentifierLeaks(src);
    const rules = f.map((x) => x.rule);
    expect(rules).toContain('identifier-leak:ssm-path');
    expect(rules).toContain('identifier-leak:pod-identity-assoc-id');
    expect(rules).toContain('identifier-leak:kb-verification-metadata');
  });

  it('respects the frontmatter allowlist', () => {
    const src = 'The cluster stores state at /k8s/development/eks/token.';
    const f = checkIdentifierLeaks(src, ['/k8s/development/eks/token']);
    expect(f).toHaveLength(0);
  });
});

describe('enumerated generalisations (PDB/cert-manager claim)', () => {
  it('routes unverified all-share-property claims to the verifier', () => {
    const src =
      '## Lessons\nPod Identity associations, PodDisruptionBudgets, and ' +
      'Certificate resources all have this characteristic.';
    const f = checkEnumeratedGeneralisations(src);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].message).toContain('per-member KB evidence');
  });
});

describe('heading JSX-expression (the acorn-500 render break)', () => {
  it('flags {#anchor} heading ids as an error', () => {
    const src = '## The Problem: Hallucination {#the-problem}\n\nbody';
    const f = checkHeadingExpressions(src);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('error');
    expect(f[0].rule).toBe('heading-jsx-expression');
    expect(f[0].line).toBe(1);
  });

  it('ignores clean headings and prose/code braces', () => {
    const src = [
      '## A Clean Heading',
      '',
      'Prose with `toolChoice: { tool: { name: "x" } }` inline.',
      '',
      '```bash',
      '# not a heading {inside a fence}',
      '```',
    ].join('\n');
    expect(checkHeadingExpressions(src)).toHaveLength(0);
  });
});
