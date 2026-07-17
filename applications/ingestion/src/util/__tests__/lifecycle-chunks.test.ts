import { describe, it, expect } from '@jest/globals';
import type { ExtractedRepoData } from '../../narrative/ProfileExtractor.js';
import { renderLifecycleChunks } from '../lifecycle-chunks.js';

function withLifecycle(lifecycle: ExtractedRepoData['lifecycle']): ExtractedRepoData {
    return { lifecycle } as unknown as ExtractedRepoData;
}

describe('renderLifecycleChunks', () => {
    it('renders a current migration as "currently X, migrated <when> from Y"', () => {
        const out = renderLifecycleChunks(withLifecycle([
            { system: 'Kubernetes platform', from: 'self-managed kubeadm', to: 'Amazon EKS 1.34', when: '2026-05', status: 'current' },
        ]));
        expect(out).toEqual([
            'Kubernetes platform: currently Amazon EKS 1.34, migrated 2026-05 from self-managed kubeadm.',
        ]);
    });

    it('omits the date when `when` is null', () => {
        const out = renderLifecycleChunks(withLifecycle([
            { system: 'CI', from: 'Jenkins', to: 'GitHub Actions', when: null, status: 'current' },
        ]));
        expect(out[0]).toBe('CI: currently GitHub Actions, migrated from Jenkins.');
    });

    it('frames planned and deprecated states distinctly', () => {
        const out = renderLifecycleChunks(withLifecycle([
            { system: 'DB', from: 'Postgres', to: 'DSQL', when: '2027', status: 'planned' },
            { system: 'Edge', from: 'CloudFront', to: 'ALB', when: null, status: 'deprecated' },
        ]));
        expect(out[0]).toBe('DB: currently Postgres; migration to DSQL planned 2027.');
        expect(out[1]).toBe('Edge: CloudFront (deprecated), superseded by ALB.');
    });

    it('returns [] when there is no lifecycle', () => {
        expect(renderLifecycleChunks(withLifecycle([]))).toEqual([]);
    });
});
