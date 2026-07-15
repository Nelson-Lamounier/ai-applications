/**
 * @format
 * Synthetic skills-agent eval fixtures - no Bedrock, no PII.
 *
 * GOLDEN passes every grader: every emitted skill resolves to a
 * verified/transferable ledger tool, the shape stays within the 5-category /
 * 8-item caps, and the lead skill (first category, first item) matches an
 * attainable JD-required skill. Each adversarial variant breaks exactly one
 * grader's invariant while leaving the other two untouched.
 */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import type { SkillsAgentOutput } from '../../agents/writer/skills-schema.js';
import type { SkillsEvalInput } from './skills-graders.js';

const LEDGER: SkillEvidenceEntry[] = [
    { tool: 'Kubernetes', status: 'verified', evidenceFiles: ['infra/k8s.yaml'], evidence: 'Ran production Kubernetes clusters', transferableBridge: '' },
    { tool: 'PostgreSQL', status: 'verified', evidenceFiles: ['db/schema.sql'], evidence: 'Owned PostgreSQL schema design', transferableBridge: '' },
    { tool: 'Docker', status: 'verified', evidenceFiles: ['Dockerfile'], evidence: 'Containerised every production service', transferableBridge: '' },
    { tool: 'Redis', status: 'transferable', evidenceFiles: [], evidence: '', transferableBridge: 'In-memory cache experience via Memcached' },
    { tool: 'Ansible', status: 'gap', evidenceFiles: [], evidence: '', transferableBridge: '' },
];

const REQUIRED_SKILLS = ['Kubernetes', 'PostgreSQL'];

const GOLDEN_OUTPUT: SkillsAgentOutput = {
    skills: [
        { category: 'Infrastructure', skills: ['Kubernetes', 'PostgreSQL', 'Docker'] },
        { category: 'Core Skills', skills: ['Redis'] },
    ],
};

export const GOLDEN_SKILLS: SkillsEvalInput = {
    output: GOLDEN_OUTPUT,
    ledger: LEDGER,
    requiredSkills: REQUIRED_SKILLS,
};

/**
 * Adversarial: the gap-status tool "Ansible" is emitted in the first
 * category -- trips ONLY membershipGrader (the ledger's own honesty model
 * marks it unsupported; `unknown_skill:Ansible`); the shape still fits the
 * caps and the lead skill is unchanged, so caps + jdPriority still pass.
 */
export const ADVERSARIAL_GAP_SKILL: SkillsEvalInput = {
    output: {
        skills: [
            { category: 'Infrastructure', skills: ['Kubernetes', 'PostgreSQL', 'Docker', 'Ansible'] },
            { category: 'Core Skills', skills: ['Redis'] },
        ],
    },
    ledger: LEDGER,
    requiredSkills: REQUIRED_SKILLS,
};

/**
 * Adversarial: 6 categories instead of <=5 (every skill named is still a
 * valid verified/transferable ledger tool, and the lead skill is unchanged)
 * -- trips ONLY capsGrader (`category_cap:6`).
 */
export const ADVERSARIAL_SIX_CATEGORIES: SkillsEvalInput = {
    output: {
        skills: [
            { category: 'Infrastructure', skills: ['Kubernetes'] },
            { category: 'Databases', skills: ['PostgreSQL'] },
            { category: 'Containers', skills: ['Docker'] },
            { category: 'Caching', skills: ['Redis'] },
            { category: 'Cat5', skills: ['Kubernetes'] },
            { category: 'Cat6', skills: ['PostgreSQL'] },
        ],
    },
    ledger: LEDGER,
    requiredSkills: REQUIRED_SKILLS,
};

/**
 * Adversarial: the attainable required skills (Kubernetes, PostgreSQL) are
 * buried behind "Docker" as the lead skill -- membership and caps are
 * unaffected (still 2 categories, 3 items, all valid ledger tools) -- trips
 * ONLY jdPriorityGrader.
 */
export const ADVERSARIAL_REQUIRED_BURIED: SkillsEvalInput = {
    output: {
        skills: [
            { category: 'Infrastructure', skills: ['Docker', 'Kubernetes', 'PostgreSQL'] },
            { category: 'Core Skills', skills: ['Redis'] },
        ],
    },
    ledger: LEDGER,
    requiredSkills: REQUIRED_SKILLS,
};
