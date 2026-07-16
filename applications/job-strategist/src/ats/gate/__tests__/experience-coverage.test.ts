/** @format */
import { describe, it, expect } from '@jest/globals';
import {
  EXPERIENCE_EMPHASIS_TOKENS, experienceTermMatch, lightStem, scoreExperienceCoverage,
  type ScorableBullet,
} from '../experience-coverage.js';
import type { ExperienceAtsTarget } from '../experience-ats-targets.js';

const target = (skill: string, anchors: string[] = []): ExperienceAtsTarget => ({
  skill, source: 'hard', verdict: 'verified', requirement: skill, anchors,
});

describe('EXPERIENCE_EMPHASIS_TOKENS', () => {
  it('carries the verbatim emphasis + discipline-suffix noise list', () => {
    for (const t of [
      'mission', 'critical', 'rapid', 'rapidly', 'complex', 'deep', 'extensive',
      'engineering', 'analysis', 'management',
    ]) {
      expect(EXPERIENCE_EMPHASIS_TOKENS.has(t)).toBe(true);
    }
  });
});

describe('lightStem', () => {
  it('strips a trailing "ly" when the remaining stem is >= 4 chars', () => {
    expect(lightStem('rapidly')).toBe('rapid');
  });

  it('strips a trailing "ing" when the remaining stem is >= 4 chars', () => {
    expect(lightStem('learning')).toBe('learn');
    expect(lightStem('scripting')).toBe('script');
  });

  it('leaves a short remainder alone (min-length guard)', () => {
    expect(lightStem('ring')).toBe('ring'); // "r" (1 char) -- guard blocks the strip
    expect(lightStem('coding')).toBe('coding'); // "cod" (3 chars) -- guard blocks the strip
  });

  it('leaves a word with no strippable suffix alone', () => {
    expect(lightStem('fly')).toBe('fly');
  });

  it('is idempotent', () => {
    for (const w of ['rapidly', 'learning', 'scripting', 'ring', 'fly', 'production']) {
      const once = lightStem(w);
      expect(lightStem(once)).toBe(once);
    }
  });
});

describe('experienceTermMatch', () => {
  it('LIVE CASE: "mission-critical production database systems" is covered against a database bullet '
    + 'that never says "mission" or "critical" -- the emphasis tokens are stripped, leaving {production, '
    + 'database} (systems is qualifier-stripped inside matchTier1)', () => {
    const text = 'Owned production database performance, tuning PostgreSQL and Aurora RDS clusters '
      + 'that processed over 10 million transactions daily.';
    expect(experienceTermMatch('mission-critical production database systems', text)).toBe(true);
  });

  it('LIVE CASE: "code reading and scripting" is covered against a JavaScript tooling bullet via '
    + 'lightStem bridging "reading"->"read" and "scripting"->"script", then matchTier1 proximity over '
    + '{code, read, script}', () => {
    const text = 'Read legacy JavaScript code and wrote scripting utilities for the build pipeline.';
    expect(experienceTermMatch('code reading and scripting', text)).toBe(true);
  });

  it('LIVE CASE: "rapid technical learning" stays missing against a self-training line -- an honest '
    + 'synonym gap ("rapid" is stripped as emphasis, but the self-training bullet never names '
    + '"technical" or "learn(ing)")', () => {
    const text = 'Regularly worked through self-guided coursework and personal projects to stay '
      + 'current with new tools.';
    expect(experienceTermMatch('rapid technical learning', text)).toBe(false);
  });

  it('REGRESSION: "Linux systems engineering" is covered against the REAL live Amazon Linux bullet '
    + '-- "engineering" is stripped as a discipline suffix and matchTier1 strips "systems", so the '
    + 'target reduces to its distinctive core {linux}', () => {
    const text = 'Guided customers through Amazon Linux (AL2 and AL2023) system setup and configuration on EC2, '
      + 'covering instance provisioning, SSH access and key management, package and systemd service configuration, '
      + 'and OS-level troubleshooting of boot, storage, and network connectivity issues.';
    expect(experienceTermMatch('Linux systems engineering', text)).toBe(true);
  });

  it('an all-emphasis target falls back to its unstripped tokens (never an empty, vacuously-true '
    + 'requirement)', () => {
    expect(experienceTermMatch('mission critical', 'Supported mission critical infrastructure '
      + 'uptime for enterprise clients')).toBe(true);
    expect(experienceTermMatch('mission critical', 'Owned infrastructure uptime for enterprise '
      + 'clients')).toBe(false);
  });

  it('proximity is still enforced -- two required tokens present but in unrelated sentences of one '
    + 'text do not match', () => {
    const text = 'Managed a production deployment pipeline for the platform team. Separately, '
      + 'maintained an internal database of vendor contacts for procurement.';
    expect(experienceTermMatch('production database', text)).toBe(false);
  });

  // G2 (run 976403b3): the target was stemmed before matchTier1 saw it, so
  // matchTier1's own LANG_CATEGORY_CUE (raw "scripting"/"languages"/
  // "programming"/"coding" + a real language named in the text) never fired,
  // and an enumeration target like "scripting (Python, Java, JavaScript, Go,
  // etc.)" was scored as requiring every language token in ONE bullet.
  describe('G2: enumeration + language-cue coverage', () => {
    const jsToolingText = 'Read legacy JavaScript code and wrote scripting utilities for the build pipeline.';

    it('an enumeration target is covered when the text names just ONE member language', () => {
      expect(experienceTermMatch('scripting (Python, Java, JavaScript, Go, etc.)', jsToolingText)).toBe(true);
    });

    it('ENUMERATION ISOLATE: the member path alone credits "database systems (Oracle, MongoDB)" against '
      + 'a bullet naming only MongoDB -- the base phrase does NOT match this text on its own', () => {
      const text = 'Migrated the user store to MongoDB with zero downtime.';
      // Prove isolation: the bare base fails against this text, so only the
      // member path can be crediting the enumeration form below.
      expect(experienceTermMatch('database systems', text)).toBe(false);
      expect(experienceTermMatch('database systems (Oracle, MongoDB)', text)).toBe(true);
    });

    it('ENUMERATION NEGATIVE: the same target stays false against a bullet naming neither member '
      + 'and lacking the base terms', () => {
      const text = 'Coordinated the quarterly release calendar for the team.';
      expect(experienceTermMatch('database systems (Oracle, MongoDB)', text)).toBe(false);
    });

    it('ENUMERATION SHORT-TOKEN GUARD: members under 3 chars never participate -- "tools (Git, Go, '
      + 'C, R)" is NOT credited by prose "go"/"c"/"r" tokens', () => {
      const text = 'Led the go-live checklist and c r review';
      expect(experienceTermMatch('tools (Git, Go, C, R)', text)).toBe(false);
    });

    it('ENUMERATION SHORT-TOKEN GUARD: a >= 3-char member still credits -- the same target is '
      + 'covered by a bullet naming Git', () => {
      const text = 'Managed branching workflows in Git for every release.';
      expect(experienceTermMatch('tools (Git, Go, C, R)', text)).toBe(true);
    });

    // NOTE: this case is actually covered by the STEMMED proximity path
    // (pass 2: "reading"->"read" bridges the bullet's leading "Read", and
    // {code, read} co-occur in one sentence) -- NOT by the pass-4 cue. The
    // pass-4 isolate is the "code review" case below.
    it('"code reading" is covered against the same bullet (via stemmed proximity, see note)', () => {
      expect(experienceTermMatch('code reading', jsToolingText)).toBe(true);
    });

    it('PASS-4 ISOLATE: "code review" is covered by a bullet with NO code/review tokens at all, '
      + 'purely via the narrowed cue + a named language exemplar', () => {
      const text = 'Prototyped internal JavaScript diagnostic tooling.';
      expect(experienceTermMatch('code review', text)).toBe(true);
    });

    it('CUE NEGATIVE: "code of conduct" never rides the language cue -- stays false against a '
      + 'Python bullet (the narrowed cue requires the reading/review/comprehension class, not a '
      + 'bare "code" token)', () => {
      const text = 'Automated deployment workflows with Python across every environment.';
      expect(experienceTermMatch('code of conduct', text)).toBe(false);
    });

    it('the unstemmed pass restores raw cue-word matching -- "scripting experience" is covered by a bullet '
      + 'naming a real language even with no exact phrase overlap', () => {
      const text = 'Wrote Python automation to provision new environments end to end.';
      expect(experienceTermMatch('scripting experience', text)).toBe(true);
    });

    it('a memberless, cueless enumeration-shaped target with absent terms stays false', () => {
      const text = 'Coordinated cross-team logistics for the quarterly offsite.';
      expect(experienceTermMatch('reporting (Excel, Tableau, PowerBI, etc.)', text)).toBe(false);
    });

    it('REGRESSION: "rapid technical learning" still stays false against the self-training line', () => {
      const text = 'Regularly worked through self-guided coursework and personal projects to stay '
        + 'current with new tools.';
      expect(experienceTermMatch('rapid technical learning', text)).toBe(false);
    });

    it('REGRESSION: "Linux systems engineering" still covers the real live Amazon Linux bullet', () => {
      const text = 'Guided customers through Amazon Linux (AL2 and AL2023) system setup and configuration on EC2, '
        + 'covering instance provisioning, SSH access and key management, package and systemd service configuration, '
        + 'and OS-level troubleshooting of boot, storage, and network connectivity issues.';
      expect(experienceTermMatch('Linux systems engineering', text)).toBe(true);
    });

    it('REGRESSION: proximity is still enforced across unrelated sentences', () => {
      const text = 'Managed a production deployment pipeline for the platform team. Separately, '
        + 'maintained an internal database of vendor contacts for procurement.';
      expect(experienceTermMatch('production database', text)).toBe(false);
    });
  });

  describe('G3: soft-skill synonym groups (run d3d9ab76 misses)', () => {
    // The live career lines demonstrate collaboration in synonym vocabulary
    // (partnered, coordinated, engaging) without ever using the JD's token.
    const collaborationLine = 'Partnered with internal engineering teams and coordinated '
      + 'cross-team escalations, engaging directly with customers throughout resolution.';

    it('LIVE MISS 1: "collaboration" is covered by a partnered/coordinated career line', () => {
      expect(experienceTermMatch('collaboration', collaborationLine)).toBe(true);
    });

    it('a modified collaboration target ("cross-functional collaboration") still rides the group', () => {
      expect(experienceTermMatch('cross-functional collaboration', collaborationLine)).toBe(true);
    });

    it('GUARD: a tech-phrase target containing a collaboration token never rides the group -- '
      + '"collaboration tools (Jira, Confluence)" stays false against the same line', () => {
      expect(experienceTermMatch('collaboration tools (Jira, Confluence)', collaborationLine)).toBe(false);
    });

    it('LIVE MISS 2: "full-stack troubleshooting" is covered by an end-to-end resolution line', () => {
      const text = 'Owned end-to-end technical resolution of customer cases across compute, '
        + 'storage, and networking services.';
      expect(experienceTermMatch('full-stack troubleshooting', text)).toBe(true);
    });

    it('GUARD: "full-stack troubleshooting" stays false when the line shows end-to-end work '
      + 'with no troubleshooting or resolution signal', () => {
      const text = 'Delivered the onboarding flow end-to-end, from design hand-off to launch.';
      expect(experienceTermMatch('full-stack troubleshooting', text)).toBe(false);
    });

    it('GUARD: a collaboration target with zero synonym evidence stays missing (fail-closed)', () => {
      const text = 'Maintained Terraform modules for the shared VPC baseline.';
      expect(experienceTermMatch('collaboration', text)).toBe(false);
    });

    it('REVIEW GUARD: "team management" never collapses to a bare {team} that rides the group -- '
      + 'stays false against a noun-only "engagement" line', () => {
      const text = 'Analysed user engagement metrics to prioritise the roadmap.';
      expect(experienceTermMatch('team management', text)).toBe(false);
    });

    it('REVIEW GUARD: "stakeholder management" stays false against a partner-as-noun line', () => {
      const text = 'Integrated with AWS Partner Central APIs and synced partner programme data feeds.';
      expect(experienceTermMatch('stakeholder management', text)).toBe(false);
    });

    it('REVIEW GUARD: a bare satellite token ("teams", "troubleshooting") never rides a group '
      + 'without its anchor concept word', () => {
      expect(experienceTermMatch('teams', 'Partnered with the platform group on rollouts.')).toBe(false);
      expect(experienceTermMatch('troubleshooting', 'Owned end-to-end technical resolution of cases.')).toBe(false);
    });

    it('REVIEW GUARD: domain vocabulary sharing a stem is not teamwork evidence -- '
      + '"collaborative filtering" and "coordinate system" stay inert', () => {
      expect(experienceTermMatch('collaboration',
        'Built a collaborative filtering recommendation engine for the product catalogue.')).toBe(false);
      expect(experienceTermMatch('collaboration',
        'Mapped coordinate system transforms for the robotics perception stack.')).toBe(false);
    });

    it('REVIEW GUARD: the UX adjective "engaging" is not teamwork evidence, but engage-with is', () => {
      expect(experienceTermMatch('collaboration',
        'Designed engaging user interfaces for the checkout flow, increasing conversion by 12%.')).toBe(false);
      expect(experienceTermMatch('collaboration',
        'Engaged with enterprise customers to gather requirements ahead of each release.')).toBe(true);
    });
  });
});

describe('scoreExperienceCoverage', () => {
  it('LIVE RUN CASE 1: "Linux systems engineering" is covered via its distinctive core {linux} even '
    + 'without the exact phrase', () => {
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

  it('LIVE RUN CASE 2: "performance and scalability analysis" is covered ONLY via anchor citation '
    + 'when the text lacks "scalability" -- re-derived under the new predicate: "analysis" is '
    + 'stripped as a discipline suffix (as GENERIC_TARGET_TOKENS did before), leaving {performance, '
    + 'scalability}, and this bullet never says "scalability", so the term path still cannot credit '
    + 'it; matches the pre-branch shipped behaviour exactly', () => {
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

  it('LIVE RUN CASE 3 (was the all-generic fallback, now the all-emphasis fallback): a target that '
    + 'reduces to zero tokens after emphasis-stripping falls back to its full token set', () => {
    const covering: ScorableBullet[] = [{
      text: 'Supported mission critical infrastructure uptime for enterprise clients', sources: [],
    }];
    expect(scoreExperienceCoverage(covering, [target('mission critical')]).covered).toBe(1);

    const partial: ScorableBullet[] = [{
      text: 'Owned infrastructure uptime for enterprise clients', sources: [],
    }];
    expect(scoreExperienceCoverage(partial, [target('mission critical')]).covered).toBe(0);
  });

  it('LIVE RUN CASE 4: zero-anchor + zero-term target stays missing (fail-closed, never vacuously '
    + 'covered)', () => {
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

  it('term match still respects matchTier1\'s own semantics for a short second token ("TCP/IP" '
    + 'reduces to requiring "tcp" -- "ip" is below matchTier1\'s 3-char significant-token floor, a '
    + 'property of matchTier1 itself, not of this predicate)', () => {
    const bullets: ScorableBullet[] = [{ text: 'Managed IP addressing schemes across the estate', sources: [] }];
    expect(scoreExperienceCoverage(bullets, [target('TCP/IP')]).covered).toBe(0);
    const both: ScorableBullet[] = [{ text: 'Hardened TCP and IP stack configuration', sources: [] }];
    expect(scoreExperienceCoverage(both, [target('TCP/IP')]).covered).toBe(1);
  });
});
