/** @format */
import { describe, it, expect } from '@jest/globals';
import { classifyComponentKind, componentNameFor } from '../component-kind.js';
import type { RepoRoleSignals } from '../component-kind.js';

const sig = (over: Partial<RepoRoleSignals> = {}): RepoRoleSignals => ({
    primaryLanguage: 'TypeScript',
    techStack: [],
    topics: [],
    archetype: {},
    evidence: {},
    fileClassCounts: {},
    ...over,
});

describe('classifyComponentKind — the live mislabels it must fix', () => {
    it('kubernetes-bootstrap (helm + argocd + k8s, ~0 source) → infra', () => {
        const s = sig({
            archetype: { has_iac: true, has_k8s_manifests: true, has_helm_chart: true, has_argocd_apps: true, has_ci: true, has_dockerfile: true },
            fileClassCounts: { source: 1, iac: 4, ci: 57, test: 37 },
        });
        expect(classifyComponentKind(s)).toBe('infra');
    });

    it('tucaken-infra (iac + k8s, source 0) → infra', () => {
        const s = sig({ archetype: { has_iac: true, has_k8s_manifests: true, has_ci: true }, fileClassCounts: { source: 0, iac: 45, ci: 63, test: 197 } });
        expect(classifyComponentKind(s)).toBe('infra');
    });

    it('tucaken-app (web app, source + tests, no infra) → frontend', () => {
        const s = sig({ techStack: ['react', 'next', 'tailwind'], archetype: { has_ci: true, has_dockerfile: true }, fileClassCounts: { source: 45, ci: 14, test: 314 } });
        expect(classifyComponentKind(s)).toBe('frontend');
    });

    it('ai-applications (has_iac but source-DOMINANT backend) → backend, NOT infra', () => {
        const s = sig({ techStack: ['bedrock', 'postgres', 'pgvector'], archetype: { has_iac: true, has_k8s_manifests: true, has_ci: true, has_dockerfile: true }, fileClassCounts: { source: 141, iac: 13, ci: 36, test: 640 } });
        expect(classifyComponentKind(s)).toBe('backend');
    });
});

describe('classifyComponentKind — other roles', () => {
    it('mobile from android/ios/react-native signals', () => {
        expect(classifyComponentKind(sig({ archetype: { has_android_dir: true } }))).toBe('mobile');
        expect(classifyComponentKind(sig({ archetype: { has_react_native: true } }))).toBe('mobile');
    });
    it('ml from ML deps / models / notebooks', () => {
        expect(classifyComponentKind(sig({ archetype: { has_requirements_with_ml_deps: true } }))).toBe('ml');
        expect(classifyComponentKind(sig({ techStack: ['pytorch'], fileClassCounts: { source: 20 } }))).toBe('ml');
    });
    it('data from a migrations/db-dominant repo', () => {
        expect(classifyComponentKind(sig({ evidence: { has_migrations: true, migration_tools: ['flyway'] }, fileClassCounts: { db: 40, source: 2 } }))).toBe('data');
    });
    it('docs from a docs-only repo', () => {
        expect(classifyComponentKind(sig({ fileClassCounts: { docs: 80, source: 0 } }))).toBe('docs');
    });
    it('backend for plain server source with no frontend framework', () => {
        expect(classifyComponentKind(sig({ techStack: ['express', 'postgres'], fileClassCounts: { source: 100, test: 50 } }))).toBe('backend');
    });
    it('falls back to shared when there is no signal', () => {
        expect(classifyComponentKind(sig())).toBe('shared');
    });
});

describe('componentNameFor — meaningful names from kind + dominant signal', () => {
    it('names GitOps infra when helm/argocd present', () => {
        expect(componentNameFor('infra', sig({ archetype: { has_helm_chart: true, has_argocd_apps: true } }))).toMatch(/GitOps/i);
    });
    it('names a plain infra component Infrastructure', () => {
        expect(componentNameFor('infra', sig({ archetype: { has_iac: true } }))).toMatch(/Infrastructure/i);
    });
    it('names frontend a Web Application', () => {
        expect(componentNameFor('frontend', sig())).toMatch(/Web App/i);
    });
    it('never returns the generic "Main"', () => {
        for (const k of ['infra', 'frontend', 'backend', 'mobile', 'data', 'ml', 'docs', 'shared'] as const) {
            expect(componentNameFor(k, sig())).not.toBe('Main');
        }
    });
});
