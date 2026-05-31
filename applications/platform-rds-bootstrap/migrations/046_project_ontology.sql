-- 046_project_ontology.sql
--
-- Seeds the project archetype + career-stage ontology as GLOBAL reference data
-- (no user_id, no RLS — mirrors technology_ontology). Used to calibrate
-- case-study generation per archetype × stage. Also adds computed_archetype /
-- computed_stage / archetype_computed_at to projects.
--
-- Source: @tucaken/ontology v0.1.0 (released 2026-05-27), transcribed verbatim
-- from tucaken-skill/packages/ontology/data/{archetypes,stages}/*.yaml.
-- Frozen snapshot: a future upstream change is a new migration.
--
-- Idempotent: IF NOT EXISTS + INSERT ... ON CONFLICT DO UPDATE.

BEGIN;

CREATE TABLE IF NOT EXISTS project_archetypes (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    description            TEXT NOT NULL,
    classification_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
    expected_sections      JSONB NOT NULL DEFAULT '[]'::jsonb,
    expected_artifacts     JSONB NOT NULL DEFAULT '[]'::jsonb,
    pillar_weights         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS project_stage_overlays (
    archetype_id          TEXT NOT NULL REFERENCES project_archetypes(id) ON DELETE CASCADE,
    stage                 TEXT NOT NULL CHECK (stage IN ('junior','mid','senior','staff')),
    priority_sections     JSONB NOT NULL DEFAULT '[]'::jsonb,
    priority_artifacts    JSONB NOT NULL DEFAULT '[]'::jsonb,
    deemphasized_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    required_pillars      JSONB NOT NULL DEFAULT '[]'::jsonb,
    stage_suggestions     JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (archetype_id, stage)
);

GRANT SELECT ON project_archetypes      TO tucaken_app;
GRANT SELECT ON project_stage_overlays  TO tucaken_app;

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS computed_archetype    TEXT,
    ADD COLUMN IF NOT EXISTS computed_stage        TEXT,
    ADD COLUMN IF NOT EXISTS archetype_computed_at TIMESTAMPTZ;


-- ── Archetypes (9) ────────────────────────────────────────────────

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('production_saas',
 'Production SaaS Application',
 'A deployed software-as-a-service product, typically multi-component, with real users and operational concerns.',
 '{"required_any":["has_deployment_workflow","has_iac","has_dockerfile","has_compose"],"positive":["has_env_example","has_compose","has_monitoring_config","has_live_url_in_readme","has_ci"],"negative":["notebook_heavy","has_single_script_entry"]}'::jsonb,
 '["hero","getting_started","architecture","deployment","design_decisions"]'::jsonb,
 '["readme_demo_link","production_deployment_evidence","architecture_diagram"]'::jsonb,
 '{"authenticity":0.2,"readability":0.2,"system_thinking":0.25,"production_reality":0.25,"stage_calibration":0.1}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('open_source_library',
 'Open-Source Library',
 'A published package consumed by other projects as an API/SDK.',
 '{"required_any":["has_package_publish_config","has_pyproject_publish"],"positive":["has_license","has_changelog","has_examples_dir","has_api_docs"],"negative":["has_deployment_workflow","has_iac"]}'::jsonb,
 '["hero","installation","usage","api_reference","contributing","changelog"]'::jsonb,
 '["readme_install_block","license_file","changelog_file"]'::jsonb,
 '{"authenticity":0.2,"readability":0.3,"system_thinking":0.2,"production_reality":0.15,"stage_calibration":0.15}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('internal_tool',
 'Internal Tool or Script',
 'Utility, CLI, or script used by the author or a small team. Often un-deployed; depth lives in the operational knowledge around it.',
 '{"required_any":["has_single_script_entry"],"positive":["has_makefile","has_env_example"],"negative":["has_iac","has_deployment_workflow","has_package_publish_config","has_compose","has_dockerfile","has_workspaces_field","has_notebooks"]}'::jsonb,
 '["hero","usage","examples"]'::jsonb,
 '["readme_demo_block"]'::jsonb,
 '{"authenticity":0.25,"readability":0.25,"system_thinking":0.15,"production_reality":0.1,"stage_calibration":0.25}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('ml_research',
 'ML / Data Research',
 'Notebook-heavy or experiment-driven data science / ML codebase. Depth lives in methodology, datasets, and reproducibility.',
 '{"required_any":["has_notebooks","has_requirements_with_ml_deps"],"positive":["has_data_dir","has_experiments_dir","has_models_dir"],"negative":["has_iac"]}'::jsonb,
 '["hero","data","methodology","results","reproducibility"]'::jsonb,
 '["readme_results_block","notebook_index"]'::jsonb,
 '{"authenticity":0.25,"readability":0.25,"system_thinking":0.2,"production_reality":0.15,"stage_calibration":0.15}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('devops_infra',
 'DevOps / Infrastructure Repository',
 'Repository whose primary artifact is infrastructure-as-code, Kubernetes manifests, or CI/CD configuration.',
 '{"required_any":["has_iac","has_k8s_manifests"],"positive":["has_helm_chart","has_argocd_apps","has_monitoring_config"],"negative":[]}'::jsonb,
 '["hero","architecture","deployment","operational_practices","runbook"]'::jsonb,
 '["architecture_diagram","runbook","rfc_documents"]'::jsonb,
 '{"authenticity":0.15,"readability":0.2,"system_thinking":0.3,"production_reality":0.25,"stage_calibration":0.1}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('monorepo',
 'Monorepo',
 'Multi-package workspace (yarn / pnpm / nx / turborepo / bazel), regardless of whether components are deployed.',
 '{"required_any":["has_workspaces_field","has_nx_json","has_turbo_json","has_pnpm_workspace"],"positive":["has_multi_package_src","has_iac"],"negative":["has_single_script_entry"]}'::jsonb,
 '["hero","architecture","packages_overview","contributing"]'::jsonb,
 '["architecture_diagram","package_map"]'::jsonb,
 '{"authenticity":0.15,"readability":0.25,"system_thinking":0.3,"production_reality":0.2,"stage_calibration":0.1}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('cli_tool',
 'Published CLI Tool',
 'Command-line tool with a published binary or npm/pip entry point.',
 '{"required_any":["has_bin_field","has_console_scripts"],"positive":["has_package_publish_config","has_man_page"],"negative":["has_iac"]}'::jsonb,
 '["hero","installation","usage","commands_reference"]'::jsonb,
 '["readme_install_block","asciinema_or_screencast"]'::jsonb,
 '{"authenticity":0.2,"readability":0.3,"system_thinking":0.2,"production_reality":0.15,"stage_calibration":0.15}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('mobile_app',
 'Mobile App',
 'iOS / Android / React Native / Flutter mobile application.',
 '{"required_any":["has_ios_dir","has_android_dir","has_root_android_app","has_root_ios_app","has_xamarin_mobile","has_react_native","has_flutter_pubspec","has_expo_config"],"positive":["has_screenshots_dir","has_app_store_link"],"negative":[]}'::jsonb,
 '["hero","screenshots","architecture","build_and_run"]'::jsonb,
 '["readme_screenshot","store_link"]'::jsonb,
 '{"authenticity":0.2,"readability":0.3,"system_thinking":0.2,"production_reality":0.2,"stage_calibration":0.1}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;

INSERT INTO project_archetypes (id, name, description, classification_signals, expected_sections, expected_artifacts, pillar_weights) VALUES
('static_site',
 'Static Site / Docs / Blog',
 'Static site, documentation site, marketing page, or blog generator.',
 '{"required_any":["has_static_site_config","has_docs_site_config"],"positive":["has_content_dir","has_deployment_workflow"],"negative":["has_iac"]}'::jsonb,
 '["hero","getting_started","structure"]'::jsonb,
 '["readme_demo_link"]'::jsonb,
 '{"authenticity":0.2,"readability":0.35,"system_thinking":0.15,"production_reality":0.2,"stage_calibration":0.1}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    classification_signals = EXCLUDED.classification_signals,
    expected_sections = EXCLUDED.expected_sections,
    expected_artifacts = EXCLUDED.expected_artifacts,
    pillar_weights = EXCLUDED.pillar_weights;


-- ── Stage overlays (36) ─────────────────────────────────────────

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('production_saas','junior',
 '["hero","getting_started","architecture","deployment","ai_usage","learning_journey"]'::jsonb,
 '["readme_demo_link","production_deployment_evidence"]'::jsonb,
 '["design_decisions"]'::jsonb,
 '["authenticity","production_reality"]'::jsonb,
 '[{"id":"ai_transparency_section","pillar":"authenticity","title":"Add an AI Usage section to your README","description":"In 2026, transparent AI usage is more credible than denied AI usage. Document which parts used AI, what you overrode, what you verified.","trigger":"ai_fingerprints_detected_or_recent","impact":0.8,"effort":0.2},{"id":"deployment_proof","pillar":"production_reality","title":"Make your deployment proof visible in the README","description":"Live URL + uptime + ''how it''s deployed'' beats three tutorial-shaped projects on a junior resume.","trigger":"has_deployment_evidence_not_in_readme","impact":0.9,"effort":0.15},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('production_saas','mid',
 '["hero","architecture","deployment","design_decisions","testing"]'::jsonb,
 '["architecture_diagram","adrs"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"architecture_diagram_missing","pillar":"system_thinking","title":"Add a system architecture diagram","description":"Mid-level engineers are evaluated on systems thinking. A diagram converts invisible work into a 5-second visual signal.","trigger":"no_architecture_diagram","impact":0.85,"effort":0.3},{"id":"adr_starter","pillar":"system_thinking","title":"Document 2-3 architectural decisions as ADRs","description":"Detected significant technology choices. Document why you chose them over alternatives.","trigger":"significant_architectural_choices_detected_and_no_adrs","impact":0.75,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('production_saas','senior',
 '["architecture","design_decisions","deployment","operational_practices","postmortems_or_incidents"]'::jsonb,
 '["adrs","runbook","rfc_documents"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"adr_backfill","pillar":"system_thinking","title":"Document your architectural decisions retroactively","description":"Code shows X, Y, Z choices. Senior interviews probe the reasoning behind these. Make it visible now.","trigger":"significant_architectural_choices_detected_and_no_adrs","impact":0.95,"effort":0.5},{"id":"postmortem_invitation","pillar":"production_reality","title":"Surface a debugging or incident story","description":"Senior engineers are evaluated on failure handling. A postmortem or lessons-learned section signals operational maturity.","trigger":"has_bug_fix_or_revert_commits","impact":0.85,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('production_saas','staff',
 '["architecture","design_decisions","cross_system_reasoning","operational_practices"]'::jsonb,
 '["rfc_documents","adrs","runbook"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"cross_system_rfc","pillar":"system_thinking","title":"Add an RFC linking this repo to broader system context","description":"Staff+ evaluation hinges on multi-system reasoning and organizational impact. Show how this component fits a larger picture.","trigger":"any","impact":0.9,"effort":0.6}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('open_source_library','junior',
 '["hero","installation","usage","learning_journey","ai_usage"]'::jsonb,
 '["readme_install_block","license_file"]'::jsonb,
 '[]'::jsonb,
 '["readability","authenticity"]'::jsonb,
 '[{"id":"ai_transparency_section","pillar":"authenticity","title":"Add an AI Usage section to your README","description":"For junior-targeting library work, transparent AI use beats invisible AI use. Document what you used AI for, what you overrode.","trigger":"ai_fingerprints_detected_or_recent","impact":0.8,"effort":0.2},{"id":"add_usage_example","pillar":"readability","title":"Add a minimal Usage example above the fold","description":"Library adoption decisions are made in 30 seconds. The smallest runnable example is the conversion event.","trigger":"no_usage_block","impact":0.85,"effort":0.2},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('open_source_library','mid',
 '["hero","installation","usage","api_reference","contributing"]'::jsonb,
 '["readme_install_block","license_file","changelog_file"]'::jsonb,
 '[]'::jsonb,
 '["readability","authenticity"]'::jsonb,
 '[{"id":"add_usage_example","pillar":"readability","title":"Add a runnable Usage example above the fold","description":"Library consumers decide adoption from the first code block. Make the smallest useful example the first thing they see.","trigger":"no_usage_block","impact":0.85,"effort":0.2},{"id":"add_changelog","pillar":"readability","title":"Add a CHANGELOG.md","description":"Library maturity is signaled by a CHANGELOG. Even a thin one beats none.","trigger":"no_changelog","impact":0.5,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('open_source_library','senior',
 '["hero","installation","usage","api_reference","design_decisions","contributing"]'::jsonb,
 '["adrs","changelog_file","semver_release_history"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","readability"]'::jsonb,
 '[{"id":"adr_design_choices","pillar":"system_thinking","title":"Document the library''s design decisions as ADRs","description":"Senior-library evaluation hinges on API design judgment, not LOC. ADRs (sync vs. async API, error model, dependency choices) carry the signal.","trigger":"any","impact":0.9,"effort":0.5},{"id":"contributing_quality","pillar":"readability","title":"Add a high-quality CONTRIBUTING.md","description":"Mature library senior signal: external contributors can land changes without DMing the author. Document the workflow.","trigger":"any","impact":0.6,"effort":0.3}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('open_source_library','staff',
 '["hero","design_decisions","governance","ecosystem"]'::jsonb,
 '["adrs","rfc_documents","governance_doc"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"governance_model","pillar":"system_thinking","title":"Document the library''s governance model","description":"Staff-level OSS signal: how decisions get made, how breaking changes are deliberated, how maintainers join. Required for credible cross-org adoption.","trigger":"any","impact":0.85,"effort":0.6}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('internal_tool','junior',
 '["hero","usage","ai_usage","learning_journey"]'::jsonb,
 '["readme_demo_block"]'::jsonb,
 '[]'::jsonb,
 '["authenticity","readability"]'::jsonb,
 '[{"id":"explain_problem","pillar":"readability","title":"Open the README with the problem this tool solves","description":"Internal-tool repos with no \"why\" read as homework. One sentence framing the problem flips it.","trigger":"any","impact":0.85,"effort":0.1},{"id":"ai_transparency_section","pillar":"authenticity","title":"Add an AI Usage note (one paragraph)","description":"Even one paragraph beats silence in 2026.","trigger":"ai_fingerprints_detected_or_recent","impact":0.7,"effort":0.15},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('internal_tool','mid',
 '["hero","usage","examples"]'::jsonb,
 '["readme_demo_block"]'::jsonb,
 '[]'::jsonb,
 '["readability","authenticity"]'::jsonb,
 '[{"id":"clarify_purpose","pillar":"readability","title":"Add a one-line ''what + who-for'' to the README hero","description":"Internal tools often have invisible purpose to outsiders. One line converts the repo from \"some script\" to \"solves X for Y\".","trigger":"any","impact":0.7,"effort":0.1}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('internal_tool','senior',
 '["hero","usage","design_decisions","operational_practices"]'::jsonb,
 '["adrs","runbook"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"tool_design_rationale","pillar":"system_thinking","title":"Document why this exists vs. existing tools","description":"Senior internal-tool signal: \"build vs. buy vs. use what''s there\" reasoning. The decision is the artifact.","trigger":"any","impact":0.8,"effort":0.3}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('internal_tool','staff',
 '["hero","design_decisions","organizational_context"]'::jsonb,
 '["rfc_documents","adrs"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"organizational_context","pillar":"system_thinking","title":"Frame the tool in organizational context","description":"Staff signal: who else uses this, what it replaced, what it unlocked. The story is the work; the code is the proof.","trigger":"any","impact":0.85,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('ml_research','junior',
 '["hero","data","methodology","results","reproducibility","ai_usage"]'::jsonb,
 '["notebook_index","readme_results_block"]'::jsonb,
 '[]'::jsonb,
 '["authenticity","readability"]'::jsonb,
 '[{"id":"add_results_block","pillar":"readability","title":"Add a one-table or one-chart Results block to the README","description":"ML repos without results read as coursework. One headline metric makes the work legible.","trigger":"any","impact":0.9,"effort":0.3},{"id":"ai_transparency_section","pillar":"authenticity","title":"Add an AI Usage section","description":"For ML work in 2026, AI-tool disclosure (Copilot, code-gen, doc-gen) is a credibility signal.","trigger":"ai_fingerprints_detected_or_recent","impact":0.7,"effort":0.2},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('ml_research','mid',
 '["hero","data","methodology","results","reproducibility"]'::jsonb,
 '["readme_results_block","notebook_index"]'::jsonb,
 '[]'::jsonb,
 '["authenticity","readability"]'::jsonb,
 '[{"id":"add_results_block","pillar":"readability","title":"Add a Results block (one table or chart) to the README","description":"ML repos without a results summary look like coursework. A single table or chart above the fold converts the repo into a paper-style artifact.","trigger":"any","impact":0.9,"effort":0.3},{"id":"reproducibility_steps","pillar":"production_reality","title":"Document reproducibility (env + commands + seed)","description":"Reviewers cannot trust results they cannot rerun. A 5-line repro block is the highest-leverage credibility signal for ML repos.","trigger":"any","impact":0.85,"effort":0.3}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('ml_research','senior',
 '["hero","methodology","results","design_decisions","reproducibility","limitations"]'::jsonb,
 '["adrs","model_card","dataset_card"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"model_card","pillar":"system_thinking","title":"Add a model card (architecture, training data, intended use, limitations)","description":"Senior ML signal: you''ve thought about misuse, bias, edge cases. Model card is the canonical artifact.","trigger":"any","impact":0.9,"effort":0.5},{"id":"experiment_tracking","pillar":"production_reality","title":"Surface experiment tracking (W&B / MLflow / sacred)","description":"Reproducibility at senior level means runs, configs, and metrics are queryable, not buried in notebooks.","trigger":"any","impact":0.75,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('ml_research','staff',
 '["hero","methodology","ecosystem_impact","design_decisions","limitations"]'::jsonb,
 '["rfc_documents","model_card"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"ecosystem_impact","pillar":"system_thinking","title":"Frame the work in research/industry ecosystem context","description":"Staff ML signal: where this fits in existing literature / production systems, what it changes, what''s still open.","trigger":"any","impact":0.9,"effort":0.5}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('devops_infra','junior',
 '["hero","getting_started","deployment","ai_usage"]'::jsonb,
 '["readme_demo_block","runbook"]'::jsonb,
 '[]'::jsonb,
 '["production_reality","readability"]'::jsonb,
 '[{"id":"what_does_this_run","pillar":"readability","title":"Open with what this infra runs and where","description":"Infra repos without context look like config dumps. One sentence (\"runs the Y service on EKS in eu-west-1\") fixes it.","trigger":"any","impact":0.85,"effort":0.1},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('devops_infra','mid',
 '["hero","architecture","deployment","operational_practices","runbook"]'::jsonb,
 '["architecture_diagram","runbook"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"ops_runbook","pillar":"production_reality","title":"Add an operational runbook","description":"Infra repos without a runbook read as code dumps. A short runbook (deploy, rollback, common failure modes) is the difference between \"I write Helm\" and \"I operate Helm in production\".","trigger":"no_runbook","impact":0.9,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('devops_infra','senior',
 '["hero","architecture","deployment","operational_practices","runbook","postmortems_or_incidents"]'::jsonb,
 '["architecture_diagram","runbook","adrs","rfc_documents"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"ops_runbook","pillar":"production_reality","title":"Add an operational runbook (deploy, rollback, common failure modes)","description":"Senior infra hires write runbooks. Their absence reads as \"writes Helm, doesn''t operate Helm\".","trigger":"no_runbook","impact":0.95,"effort":0.4},{"id":"failure_mode_doc","pillar":"production_reality","title":"Document at least one real incident or near-miss","description":"Senior signal: you''ve been on-call for this thing and survived. One postmortem beats a perfect README.","trigger":"any","impact":0.8,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('devops_infra','staff',
 '["hero","architecture","cross_system_reasoning","design_decisions","operational_practices"]'::jsonb,
 '["rfc_documents","adrs","runbook"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"platform_thesis","pillar":"system_thinking","title":"Add a ''platform thesis'' — what this platform is for and what it explicitly is not","description":"Staff infra signal: scope discipline. What this enables, what it refuses to do, and why. Prevents the platform from becoming a kitchen-sink.","trigger":"any","impact":0.9,"effort":0.5}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('monorepo','junior',
 '["hero","packages_overview","getting_started","ai_usage"]'::jsonb,
 '["package_map"]'::jsonb,
 '[]'::jsonb,
 '["readability","authenticity"]'::jsonb,
 '[{"id":"packages_map","pillar":"readability","title":"Add a ''Packages'' table (one line per workspace)","description":"Monorepos read as mazes without a map. One line per package converts opacity into navigation.","trigger":"any","impact":0.9,"effort":0.2},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('monorepo','mid',
 '["hero","architecture","packages_overview","contributing"]'::jsonb,
 '["architecture_diagram","package_map"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","readability"]'::jsonb,
 '[{"id":"packages_map","pillar":"readability","title":"Add a ''Packages'' section listing each workspace + purpose","description":"Monorepos look opaque without a package map. One line per workspace converts the repo from a maze into a system.","trigger":"any","impact":0.85,"effort":0.2}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('monorepo','senior',
 '["hero","architecture","packages_overview","design_decisions","build_tooling"]'::jsonb,
 '["architecture_diagram","adrs","package_map"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"monorepo_rationale","pillar":"system_thinking","title":"Document why monorepo over polyrepo (one ADR)","description":"Senior signal: every monorepo is a decision. State the constraint (shared deps, atomic refactors, build caching) and the trade.","trigger":"any","impact":0.85,"effort":0.3}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('monorepo','staff',
 '["hero","architecture","build_tooling","cross_system_reasoning","design_decisions"]'::jsonb,
 '["rfc_documents","adrs"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"build_perf_story","pillar":"system_thinking","title":"Document build/CI perf story (cache hit rate, cold vs. warm, hermeticity)","description":"Staff monorepo signal: you''ve measured and optimized the dev-loop tax this shape imposes. Numbers beat narrative.","trigger":"any","impact":0.85,"effort":0.5}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('cli_tool','junior',
 '["hero","installation","usage","ai_usage"]'::jsonb,
 '["readme_install_block","asciinema_or_screencast"]'::jsonb,
 '[]'::jsonb,
 '["readability","authenticity"]'::jsonb,
 '[{"id":"add_demo_recording","pillar":"readability","title":"Add an asciinema or GIF demo above the fold","description":"CLI tools are bought in 5 seconds. A recording converts more visitors than any README paragraph.","trigger":"no_demo_media","impact":0.9,"effort":0.25},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('cli_tool','mid',
 '["hero","installation","usage","commands_reference"]'::jsonb,
 '["readme_install_block","asciinema_or_screencast"]'::jsonb,
 '[]'::jsonb,
 '["readability","authenticity"]'::jsonb,
 '[{"id":"add_demo_recording","pillar":"readability","title":"Add an asciinema or GIF demo above the fold","description":"CLI tools live or die on the 5-second demo. A recording is worth more than 200 lines of README text.","trigger":"no_demo_media","impact":0.9,"effort":0.25}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('cli_tool','senior',
 '["hero","usage","commands_reference","design_decisions","contributing"]'::jsonb,
 '["adrs","man_page"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","readability"]'::jsonb,
 '[{"id":"ux_decisions","pillar":"system_thinking","title":"Document CLI UX decisions (flag taxonomy, exit codes, machine-readable output)","description":"Senior CLI signal: you''ve thought about scripts piping into your tool, not just humans typing it.","trigger":"any","impact":0.85,"effort":0.4}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('cli_tool','staff',
 '["hero","ecosystem","design_decisions","governance"]'::jsonb,
 '["rfc_documents","adrs","governance_doc"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"ecosystem_strategy","pillar":"system_thinking","title":"Document ecosystem strategy (plugins, integrations, what this composes with)","description":"Staff CLI signal: tools that endure are composable. State the extension points and the boundaries.","trigger":"any","impact":0.85,"effort":0.5}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('mobile_app','junior',
 '["hero","screenshots","build_and_run","ai_usage"]'::jsonb,
 '["readme_screenshot","store_link"]'::jsonb,
 '[]'::jsonb,
 '["readability","production_reality"]'::jsonb,
 '[{"id":"screenshots_above_fold","pillar":"readability","title":"Put 2-3 screenshots above the fold","description":"Mobile apps without screenshots invisibilise the entire UI work. Images are the work.","trigger":"no_screenshots","impact":0.95,"effort":0.15},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('mobile_app','mid',
 '["hero","screenshots","architecture","build_and_run"]'::jsonb,
 '["readme_screenshot","store_link"]'::jsonb,
 '[]'::jsonb,
 '["readability","production_reality"]'::jsonb,
 '[{"id":"screenshots_above_fold","pillar":"readability","title":"Put screenshots above the fold","description":"Mobile-app repos without screenshots underrepresent the work entirely. Even 2-3 images convert the repo from text to artifact.","trigger":"no_screenshots","impact":0.95,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('mobile_app','senior',
 '["hero","screenshots","architecture","design_decisions","deployment","operational_practices"]'::jsonb,
 '["architecture_diagram","adrs","store_link"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking","production_reality"]'::jsonb,
 '[{"id":"mobile_arch_decisions","pillar":"system_thinking","title":"Document state-mgmt / nav / offline-sync decisions","description":"Senior mobile signal: opinionated choices on Redux-vs-Zustand, nav lib, offline strategy. The reasoning is the moat.","trigger":"any","impact":0.85,"effort":0.4},{"id":"release_pipeline_doc","pillar":"production_reality","title":"Document the release pipeline (TestFlight / Play internal track)","description":"Senior signal: you''ve shipped, not just built. Pipeline = proof.","trigger":"any","impact":0.8,"effort":0.3}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('mobile_app','staff',
 '["hero","architecture","cross_system_reasoning","design_decisions","operational_practices"]'::jsonb,
 '["rfc_documents","adrs"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"platform_strategy","pillar":"system_thinking","title":"Document multi-platform strategy (iOS / Android / web parity)","description":"Staff mobile signal: cross-platform consistency, code-sharing strategy, feature-flag rollouts, A/B story.","trigger":"any","impact":0.85,"effort":0.5}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('static_site','junior',
 '["hero","getting_started","ai_usage"]'::jsonb,
 '["readme_demo_link"]'::jsonb,
 '[]'::jsonb,
 '["readability"]'::jsonb,
 '[{"id":"demo_link","pillar":"readability","title":"Put the live site URL above the fold","description":"Static-site repo without a link is just markdown. The URL is the artifact.","trigger":"any","impact":0.9,"effort":0.1},{"id":"learning_journey_doc","pillar":"readability","title":"Add a ''What I Learned'' section to the README","description":"Juniors-specific signal validated in 2026 portfolio advice (DEV.to / Hashnode / r/cscareerquestions): document the problems you hit and what you''d do differently. Converts a project from \"thing I built\" into \"evidence of how I think\".","trigger":"any","impact":0.7,"effort":0.15}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('static_site','mid',
 '["hero","getting_started","structure"]'::jsonb,
 '["readme_demo_link"]'::jsonb,
 '[]'::jsonb,
 '["readability"]'::jsonb,
 '[{"id":"demo_link","pillar":"readability","title":"Surface the live site URL in the README hero","description":"A static-site repo without a live link is just markdown. The URL is the artifact.","trigger":"any","impact":0.9,"effort":0.1}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('static_site','senior',
 '["hero","getting_started","structure","design_decisions","performance"]'::jsonb,
 '["readme_demo_link","lighthouse_scores"]'::jsonb,
 '[]'::jsonb,
 '["readability","production_reality"]'::jsonb,
 '[{"id":"perf_story","pillar":"production_reality","title":"Add a performance / Lighthouse story","description":"Senior frontend / static-site signal: measured, optimized, documented. Score numbers beat \"it''s fast\".","trigger":"any","impact":0.8,"effort":0.3}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;

INSERT INTO project_stage_overlays (archetype_id, stage, priority_sections, priority_artifacts, deemphasized_sections, required_pillars, stage_suggestions) VALUES
('static_site','staff',
 '["hero","design_decisions","cross_system_reasoning","ecosystem"]'::jsonb,
 '["rfc_documents","adrs"]'::jsonb,
 '[]'::jsonb,
 '["system_thinking"]'::jsonb,
 '[{"id":"content_system","pillar":"system_thinking","title":"Document the content system (CMS, MDX pipeline, i18n)","description":"Staff signal: site is a platform, not a one-off. State the model that makes ongoing publishing cheap.","trigger":"any","impact":0.85,"effort":0.5}]'::jsonb)
ON CONFLICT (archetype_id, stage) DO UPDATE SET
    priority_sections = EXCLUDED.priority_sections,
    priority_artifacts = EXCLUDED.priority_artifacts,
    deemphasized_sections = EXCLUDED.deemphasized_sections,
    required_pillars = EXCLUDED.required_pillars,
    stage_suggestions = EXCLUDED.stage_suggestions;


COMMIT;
