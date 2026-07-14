/**
 * @format
 * Shared `succeeds`-edge peer-predecessor guard.
 *
 * Both migration-reframe.ts (career/bullet-level drift) and code-truth.ts
 * (verified-match drift) walk the SAME `succeeds` ontology edges (predecessor
 * canonical -> successor canonicals) to decide whether a documented/claimed
 * technology is genuinely superseded by the candidate's current code. Both
 * need the identical PEER-PREDECESSOR check: don't treat a predecessor as
 * superseded when a PEER predecessor of the same successor (e.g. kubeadm vs
 * self_hosted_kubernetes, both -> aws_eks) is still present in code — that
 * peer is the family's real current approach, and flagging the other
 * predecessor as "superseded" would be a false positive. Extracted here so
 * the two modules cannot drift apart (this module has no dependents that
 * would create an import cycle with either).
 */

export type SucceedsEdges = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * True when some PEER of `predecessor` (a different `succeedsEdges` key that
 * shares at least one successor with `successors`) is itself present in
 * `code`. When true, `predecessor` should NOT be treated as superseded — the
 * peer is the family's genuinely current approach.
 */
export function peerPredecessorStillCurrent(
    succeedsEdges: SucceedsEdges,
    code: ReadonlySet<string>,
    predecessor: string,
    successors: ReadonlySet<string>,
): boolean {
    return [...succeedsEdges].some(([peer, peerSuccessors]) =>
        peer !== predecessor && code.has(peer) && [...peerSuccessors].some((s) => successors.has(s)));
}
