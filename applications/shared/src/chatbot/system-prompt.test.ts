/** @format */
import { CHATBOT_SYSTEM_PROMPT } from './system-prompt.js';

describe('CHATBOT_SYSTEM_PROMPT — no hardcoded infrastructure facts', () => {
    // Facts belong in the KB/RAG data, never in the prompt. Hardcoding them
    // caused the stale kubeadm-vs-EKS answer. This guard blocks reintroduction.
    const bannedFactPatterns: Array<[string, RegExp]> = [
        ['kubeadm', /kubeadm/i],
        ['EKS', /\bEKS\b/],
        ['GKE', /\bGKE\b/],
        ['AKS', /\bAKS\b/],
        ['Terraform', /Terraform/i],
        ['K3s', /K3s/i],
        ['fixed node count', /\b6 nodes\b/i],
    ];

    it.each(bannedFactPatterns)('does not hardcode the fact: %s', (_label, pattern) => {
        expect(CHATBOT_SYSTEM_PROMPT).not.toMatch(pattern);
    });
});

describe('CHATBOT_SYSTEM_PROMPT — retains behavioural guardrails', () => {
    it('keeps the retrieved-context grounding boundary', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('SCOPE BOUNDARY');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('retrieved_context');
    });

    it('keeps the anti-embellishment section', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('ANTI-EMBELLISHMENT');
    });

    it('keeps the JSON response contract', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('"prose"');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('"metrics"');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('"tags"');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('"followUp"');
    });

    it('keeps a dynamic caller-role persona', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('`recruiter`');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('`engineer`');
    });
});
