/** @format */

export type SourceLayer = 'syft' | 'treesitter' | 'iac' | 'dockerfile' | 'readme';

export const CONFIDENCE_BY_LAYER: Record<SourceLayer, number> = {
    syft:       0.95,
    treesitter: 0.85,
    iac:        0.85,
    dockerfile: 0.80,
    readme:     0.50,
};

/** One extracted occurrence before ontology resolution. */
export interface RawTechnologyEvidence {
    raw_name:     string;
    ecosystem?:   string;
    source_layer: SourceLayer;
    file_path:    string;
    line_start?:  number;
    line_end?:    number;
}

/** A resolved (or unresolved) evidence row ready to persist. */
export interface TechnologyEvidenceRow {
    userId:        string;
    repoFullName:  string;
    commitSha:     string;
    technologyId:  string | null;
    rawName:       string;
    ecosystem:     string | null;
    sourceLayer:   SourceLayer;
    filePath:      string;
    lineStart:     number | null;
    lineEnd:       number | null;
    confidence:    number;
    ontologyVersion: number;
}

export interface OntologyRow {
    canonicalName: string;
    displayName:   string;
    category:      string;
}

export interface ParityRunRow {
    userId:               string;
    repoFullName:         string;
    commitSha:            string;
    ontologyVersion:      number;
    l1CanonicalCount:     number;
    llmCanonicalCount:    number;
    llmUnresolvableCount: number;
    intersectionCount:    number;
    recall:               number;
    l1OnlyExamples:       string[];
    llmOnlyExamples:      string[];
}
