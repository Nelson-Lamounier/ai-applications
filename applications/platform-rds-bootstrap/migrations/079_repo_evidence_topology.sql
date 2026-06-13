-- =============================================================================
-- 079_repo_evidence_topology.sql
-- =============================================================================
-- Adds repo_sync_state.evidence_topology — the deterministic, manifest+tree
-- evidence derived at ingestion (evidence-topology.ts): package.json scripts
-- (test/lint/build/typecheck), DB-migration ecosystem (raw SQL, Prisma, Alembic,
-- Flyway, Liquibase, TypeORM, Sequelize, Knex, Drizzle, Django, Rails, EF Core,
-- Laravel, Phinx, migrate-mongo, …), and monorepo shape.
--
-- Separate from archetype_signals (the gated 46-key classifier vocabulary) so it
-- can grow independently. JSONB { "<signal>": boolean | string[] }. Idempotent.
-- =============================================================================

ALTER TABLE repo_sync_state
    ADD COLUMN IF NOT EXISTS evidence_topology JSONB;
