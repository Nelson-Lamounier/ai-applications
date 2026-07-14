/** @format */
import { peerPredecessorStillCurrent } from './succeeds-edges.js';

// kubeadm and self_hosted_kubernetes are both predecessors of aws_eks.
const SUCCEEDS = new Map<string, Set<string>>([
    ['self_hosted_kubernetes', new Set(['aws_eks'])],
    ['kubeadm', new Set(['aws_eks'])],
]);

describe('peerPredecessorStillCurrent', () => {
    it('is true when a peer predecessor of the same successor is present in code', () => {
        const code = new Set(['self_hosted_kubernetes', 'aws_eks']);
        expect(peerPredecessorStillCurrent(SUCCEEDS, code, 'kubeadm', SUCCEEDS.get('kubeadm')!)).toBe(true);
    });

    it('is false when no peer predecessor is present in code', () => {
        const code = new Set(['aws_eks']);
        expect(peerPredecessorStillCurrent(SUCCEEDS, code, 'kubeadm', SUCCEEDS.get('kubeadm')!)).toBe(false);
    });

    it('is false when the only "peer" present in code is the predecessor itself', () => {
        const code = new Set(['kubeadm', 'aws_eks']);
        expect(peerPredecessorStillCurrent(SUCCEEDS, code, 'kubeadm', SUCCEEDS.get('kubeadm')!)).toBe(false);
    });

    it('is false when a peer is present in code but shares no successor', () => {
        const succeeds = new Map<string, Set<string>>([
            ['kubeadm', new Set(['aws_eks'])],
            ['heroku', new Set(['aws_ecs'])],
        ]);
        const code = new Set(['heroku', 'aws_eks']);
        expect(peerPredecessorStillCurrent(succeeds, code, 'kubeadm', succeeds.get('kubeadm')!)).toBe(false);
    });
});
