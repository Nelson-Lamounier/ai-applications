/** @format */

/**
 * Deterministic mapping from a technology_ontology category (30 values) to a
 * skill_ontology category (15 values) — so tool canonicals derived into the
 * skill lane (TechnologyDerivedSkillSource, T011b) land in a sensible skill
 * category. Pure + total: any unknown input falls back to 'other'.
 *
 * (Originally scoped for O*NET groupings; O*NET was dropped on verified data —
 * research D7 — so this now serves the technology_ontology derivation.)
 */

const TECH_TO_SKILL: Readonly<Record<string, string>> = {
    cloud_compute:       'cloud',
    cloud_serverless:    'cloud',
    cloud_storage:       'cloud',
    cloud_networking:    'cloud',
    language:            'language',
    runtime:             'backend',
    api_protocol:        'api',
    build_tool:          'devops',
    package_manager:     'devops',
    ci_cd:               'devops',
    framework_web:       'frontend',
    framework_mobile:    'frontend',
    framework_ml:        'ml',
    ai_platform:         'ml',
    auth:                'security',
    cloud_security:      'security',
    testing:             'testing',
    observability:       'observability',
    database_relational: 'database',
    database_kv:         'database',
    database_nosql:      'database',
    database_search:     'database',
    cloud_database:      'database',
    database_vector:     'data',
    message_broker:      'architecture',
    orchestration:       'infrastructure',
    container_runtime:   'infrastructure',
    iac:                 'infrastructure',
    developer_tool:      'other',
    payment:             'other',
};

/** The 15 valid skill_ontology categories (migration 092). */
export const SKILL_CATEGORIES = [
    'language', 'backend', 'frontend', 'infrastructure', 'devops', 'data', 'ml',
    'observability', 'security', 'testing', 'api', 'database', 'architecture', 'cloud', 'other',
] as const;

/** Map a technology category to a skill category; unknown → 'other'. */
export function mapTechCategoryToSkillCategory(techCategory: string): string {
    return TECH_TO_SKILL[techCategory] ?? 'other';
}
