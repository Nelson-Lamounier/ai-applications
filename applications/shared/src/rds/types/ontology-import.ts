/** @format */

/** One entry yielded by a Source before categorization. */
export interface RawImportEntry {
    source_identifier:       string;
    proposed_canonical_name: string;   // pre-slugified
    proposed_display_name:   string;
    description?:            string;
    keywords?:              string[];
    popularity?:            number;
    source_metadata:        Record<string, unknown>;
    repository_url?:        string;
}

/** The 30 valid categories (034 + developer_tool from 036). */
export type OntologyCategory =
    | 'language' | 'framework_web' | 'framework_mobile' | 'framework_ml' | 'runtime'
    | 'database_relational' | 'database_nosql' | 'database_vector' | 'database_search'
    | 'database_kv' | 'message_broker' | 'observability' | 'cloud_compute' | 'cloud_storage'
    | 'cloud_database' | 'cloud_serverless' | 'cloud_networking' | 'cloud_security' | 'iac'
    | 'ci_cd' | 'container_runtime' | 'orchestration' | 'api_protocol' | 'testing'
    | 'build_tool' | 'package_manager' | 'auth' | 'payment' | 'ai_platform' | 'developer_tool';

export const ONTOLOGY_CATEGORIES: readonly OntologyCategory[] = [
    'language','framework_web','framework_mobile','framework_ml','runtime',
    'database_relational','database_nosql','database_vector','database_search',
    'database_kv','message_broker','observability','cloud_compute','cloud_storage',
    'cloud_database','cloud_serverless','cloud_networking','cloud_security','iac',
    'ci_cd','container_runtime','orchestration','api_protocol','testing',
    'build_tool','package_manager','auth','payment','ai_platform','developer_tool',
];

/** Result of categorizing one entry. */
export interface CategorizationResult {
    decision: 'yes' | 'no' | 'maybe';
    category: OntologyCategory | null;
    via:      'pattern' | 'override' | 'source_metadata' | 'llm' | 'none';
    reasoning?: string;
}

export interface ImportRunCounts {
    entriesFetched: number; entriesInserted: number; entriesUpdated: number;
    entriesDeactivated: number; aliasMerges: number; unresolvedCount: number;
    reviewQueueAdded: number;
}
