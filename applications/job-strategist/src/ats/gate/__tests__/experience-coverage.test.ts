/** @format */
import { describe, it, expect } from '@jest/globals';
import {
  GENERIC_TARGET_TOKENS, requiredTerms, scoreExperienceCoverage, type ScorableBullet,
} from '../experience-coverage.js';
import type { ExperienceAtsTarget } from '../experience-ats-targets.js';

const target = (skill: string, anchors: string[] = []): ExperienceAtsTarget => ({
  skill, source: 'hard', verdict: 'verified', requirement: skill, anchors,
});

describe('GENERIC_TARGET_TOKENS', () => {
  it('carries the verbatim generic-noise list', () => {
    for (const t of [
      'systems', 'system', 'engineering', 'experience', 'analysis', 'skills',
      'skill', 'knowledge', 'management', 'ability', 'and', 'of', 'the',
    ]) {
      expect(GENERIC_TARGET_TOKENS.has(t)).toBe(true);
    }
  });
});

describe('requiredTerms', () => {
  it('strips generic tokens, keeping only the discriminating core', () => {
    expect(requiredTerms('Linux systems engineering')).toEqual(['linux']);
  });

  it('keeps every significant token when none is generic', () => {
    expect(requiredTerms('performance and scalability analysis')).toEqual(['performance', 'scalability']);
  });

  it('falls back to the full token set when every token is generic', () => {
    expect(requiredTerms('systems engineering')).toEqual(['systems', 'engineering']);
  });

  it('returns [] for an empty/whitespace skill (no vacuous match downstream)', () => {
    expect(requiredTerms('')).toEqual([]);
    expect(requiredTerms('   ')).toEqual([]);
  });
});

describe('scoreExperienceCoverage', () => {
  it('LIVE RUN CASE 1: "Linux systems engineering" is covered via term {linux} even without the exact phrase', () => {
    const bullets: ScorableBullet[] = [{
      text: 'Guided customers through Amazon Linux (AL2 and AL2023) system setup and configuration on EC2, '
        + 'covering instance provisioning, SSH access and key management, package and systemd service configuration, '
        + 'and OS-level troubleshooting of boot, storage, and network connectivity issues.',
      sources: ['c0.h0'],
    }];
    const targets = [target('Linux systems engineering')];
    const result = scoreExperienceCoverage(bullets, targets);
    expect(result.covered).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it('LIVE RUN CASE 2: "performance and scalability analysis" is covered ONLY via anchor citation when the text lacks "scalability"', () => {
    const bulletNoAnchor: ScorableBullet[] = [{
      text: 'Tuned service performance under heavy load, cutting p99 latency significantly',
      sources: ['c0.h0'],
    }];
    const noAnchorTargets = [target('performance and scalability analysis')];
    expect(scoreExperienceCoverage(bulletNoAnchor, noAnchorTargets).covered).toBe(0);

    const bulletWithAnchor: ScorableBullet[] = [{
      text: 'Tuned service performance under heavy load, cutting p99 latency significantly',
      sources: ['c0.h0'],
    }];
    const anchoredTargets = [target('performance and scalability analysis', ['c0.h0'])];
    const anchored = scoreExperienceCoverage(bulletWithAnchor, anchoredTargets);
    expect(anchored.covered).toBe(1);
    expect(anchored.missing).toEqual([]);
  });

  it('LIVE RUN CASE 3: an all-generic target ("systems engineering") is scored against its full token set', () => {
    const covering: ScorableBullet[] = [{ text: 'Owned systems engineering for the fleet', sources: [] }];
    expect(scoreExperienceCoverage(covering, [target('systems engineering')]).covered).toBe(1);

    const partial: ScorableBullet[] = [{ text: 'Owned all backend systems end to end', sources: [] }];
    expect(scoreExperienceCoverage(partial, [target('systems engineering')]).covered).toBe(0);
  });

  it('LIVE RUN CASE 4: zero-anchor + zero-term target stays missing (fail-closed, never vacuously covered)', () => {
    const bullets: ScorableBullet[] = [{ text: 'Anything at all goes here, any words whatsoever', sources: ['c0.h0'] }];
    const result = scoreExperienceCoverage(bullets, [target('', [])]);
    expect(result.covered).toBe(0);
    expect(result.missing).toEqual(['']);
  });

  it('is covered when a bullet cites an anchor id, regardless of its text', () => {
    const bullets: ScorableBullet[] = [{ text: 'Unrelated prose with no matching terms whatsoever', sources: ['c1.h2'] }];
    const result = scoreExperienceCoverage(bullets, [target('Kubernetes', ['c1.h2'])]);
    expect(result.covered).toBe(1);
  });

  it('term match requires EVERY required term, whole-word, order-free', () => {
    const bullets: ScorableBullet[] = [{ text: 'Managed IP addressing schemes across the estate', sources: [] }];
    // "tcp" is absent -- only "ip" is present -- must not credit a partial match
    expect(scoreExperienceCoverage(bullets, [target('TCP/IP')]).covered).toBe(0);
    const both: ScorableBullet[] = [{ text: 'Hardened TCP and IP stack configuration', sources: [] }];
    expect(scoreExperienceCoverage(both, [target('TCP/IP')]).covered).toBe(1);
  });
});
