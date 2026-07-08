-- 117_container_orchestration_transfer_seed.sql
--
-- Extend the transfer graph (see 115) with the container-tooling and
-- orchestration families surfaced as unbridgeable gaps on live JD runs:
-- Podman, Docker Swarm and Docker Compose had no canonicals at all, so
-- formatTechTransferContext could never hand the matcher a transfer group
-- for them (observed: Podman/Docker Swarm flagged as plain gaps for a
-- candidate with daily Docker + EKS evidence).
--
-- Family discipline (see 115): families are connected components over ALL
-- edge kinds and must stay DISJOINT.
--   * Container tooling: docker <-> podman (related_to, OCI-compatible
--     runtimes), docker_compose part_of docker.
--   * Orchestration: kubernetes joins its own managed family
--     (aws_eks implements kubernetes) and docker_swarm relates to
--     kubernetes. No edge crosses the two families.
--
-- Also adds php/hack canonicals (languages, no edges) so gap rows for them
-- canonicalise and dedupe ('PHP/Hack' + 'PHP' + 'Hack' observed as three
-- separate gap rows on the Meta run).
--
-- Idempotent: ON CONFLICT DO NOTHING; name-resolved edges no-op when a
-- canonical is absent.

INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source, popularity_score)
VALUES
    ('podman',         'Podman',         'container_runtime', 'curated', 'jd_transfer_seed', 50),
    ('docker_swarm',   'Docker Swarm',   'orchestration',     'curated', 'jd_transfer_seed', 40),
    ('docker_compose', 'Docker Compose', 'container_runtime', 'curated', 'jd_transfer_seed', 70),
    ('php',            'PHP',            'language',          'curated', 'jd_transfer_seed', 70),
    ('hack',           'Hack',           'language',          'curated', 'jd_transfer_seed', 30)
ON CONFLICT (canonical_name) DO NOTHING;

INSERT INTO technology_aliases (technology_id, alias)
SELECT o.id, a.alias
FROM (VALUES
    ('podman',         'podman'),
    ('docker_swarm',   'docker swarm'),
    ('docker_swarm',   'swarm mode'),
    ('docker_compose', 'docker compose'),
    ('docker_compose', 'docker-compose'),
    ('php',            'php'),
    ('hack',           'hack'),
    ('hack',           'hacklang')
) AS a(canonical, alias)
JOIN technology_ontology o ON o.canonical_name = a.canonical
ON CONFLICT DO NOTHING;

INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT f.id, t.id, v.kind
FROM (VALUES
    -- Container tooling family
    ('podman',         'docker',     'related_to'),
    ('docker_compose', 'docker',     'part_of'),
    -- Orchestration family: kubernetes joins the managed-k8s component,
    -- swarm joins as the related orchestrator.
    ('aws_eks',        'kubernetes', 'implements'),
    ('docker_swarm',   'kubernetes', 'related_to')
) AS v(from_name, to_name, kind)
JOIN technology_ontology f ON f.canonical_name = v.from_name
JOIN technology_ontology t ON t.canonical_name = v.to_name
ON CONFLICT DO NOTHING;
