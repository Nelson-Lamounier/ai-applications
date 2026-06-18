/** @format */
/**
 * Croissant data card for a repository's RAG knowledge base.
 *
 * The RAG-domain counterpart to the tech-extractor's CycloneDX export: where
 * CycloneDX describes a repo's software bill of materials, MLCommons Croissant
 * (https://mlcommons.org/croissant) is the standard ML-dataset description — the
 * "data card" for the chunk + embedding corpus we build in `document_embeddings`.
 *
 * Pure — no I/O. The repository method aggregates the rows and calls
 * {@link buildCroissant}; this stays unit-testable without a database, mirroring
 * `buildCycloneDxBom`.
 */

/** The aggregate facts a repo's KB needs to be described as a Croissant dataset. */
export interface CroissantInput {
    readonly repoFullName: string;
    /** Number of chunks (records) in the KB for this repo. */
    readonly recordCount: number;
    /** Head commit the content was ingested from (provenance). */
    readonly commitSha?: string;
    /** Embedding model id + dimension (from chunk lineage). */
    readonly embeddingModel?: string;
    readonly embeddingDim?: number;
    /** Enrichment model id (from chunk lineage). */
    readonly enrichmentModel?: string;
    /** Distinct canonical skills across the KB — the capability vocabulary. */
    readonly skills?: string[];
}

interface CroissantField {
    readonly '@type': 'cr:Field';
    readonly '@id': string;
    readonly name: string;
    readonly description: string;
    readonly dataType: string;
    readonly repeated?: boolean;
}

interface CroissantRecordSet {
    readonly '@type': 'cr:RecordSet';
    readonly '@id': string;
    readonly name: string;
    readonly description: string;
    readonly field: CroissantField[];
}

/** The subset of a Croissant 1.0 dataset document we emit. */
export interface CroissantDataset {
    readonly '@context': Record<string, unknown>;
    readonly '@type': 'sc:Dataset';
    readonly conformsTo: 'http://mlcommons.org/croissant/1.0';
    readonly name: string;
    readonly description: string;
    /** Head commit sha — dataset version/provenance. */
    readonly version?: string;
    /** Capability vocabulary (canonical skills). */
    readonly keywords?: string[];
    readonly recordSet: readonly CroissantRecordSet[];
}

/** Standard Croissant 1.0 JSON-LD context (schema.org + the cr: vocabulary). */
const CROISSANT_CONTEXT: Record<string, unknown> = {
    '@language':  'en',
    '@vocab':     'https://schema.org/',
    sc:           'https://schema.org/',
    cr:           'http://mlcommons.org/croissant/',
    dct:          'http://purl.org/dc/terms/',
    conformsTo:   'dct:conformsTo',
    dataType:     { '@id': 'cr:dataType', '@type': '@vocab' },
    field:        'cr:field',
    recordSet:    'cr:recordSet',
    repeated:     'cr:repeated',
    keywords:     'sc:keywords',
};

/** Slugify a repo full name into a Croissant-safe dataset name. */
function datasetName(repoFullName: string): string {
    return `rag-kb-${repoFullName.replaceAll('/', '-')}`;
}

/** The fixed chunk schema each `document_embeddings` row exposes as a record. */
function chunkFields(): CroissantField[] {
    const f = (name: string, dataType: string, description: string, repeated?: boolean): CroissantField => ({
        '@type': 'cr:Field',
        '@id':   `chunks/${name}`,
        name,
        description,
        dataType,
        ...(repeated ? { repeated: true } : {}),
    });
    return [
        f('file_path',   'sc:Text',    'Source file the chunk was extracted from.'),
        f('chunk_index', 'sc:Integer', 'Ordinal of the chunk within the file.'),
        f('line_start',  'sc:Integer', '1-based first source line of the chunk (citable provenance).'),
        f('line_end',    'sc:Integer', '1-based last source line of the chunk.'),
        f('commit_sha',  'sc:Text',    'Commit the content was ingested from.'),
        f('content',     'sc:Text',    'The chunk text.'),
        f('skills',      'sc:Text',    'Canonical skills the chunk evidences.', true),
        f('embedding',   'sc:Float',   'Embedding vector for similarity retrieval.', true),
    ];
}

/** Build a Croissant data card describing a repo's RAG knowledge base. */
export function buildCroissant(input: CroissantInput): CroissantDataset {
    let embeddingNote: string | null = null;
    if (input.embeddingModel) {
        const dim = input.embeddingDim ? ` (${input.embeddingDim}d)` : '';
        embeddingNote = `embeddings ${input.embeddingModel}${dim}`;
    }
    const provenance = [
        `${input.recordCount} chunks`,
        input.commitSha ? `commit ${input.commitSha}` : null,
        embeddingNote,
        input.enrichmentModel ? `enrichment ${input.enrichmentModel}` : null,
    ].filter((p): p is string => p !== null).join('; ');

    return {
        '@context':  CROISSANT_CONTEXT,
        '@type':     'sc:Dataset',
        conformsTo:  'http://mlcommons.org/croissant/1.0',
        name:        datasetName(input.repoFullName),
        description: `RAG knowledge base for ${input.repoFullName} — ${provenance}.`,
        ...(input.commitSha ? { version: input.commitSha } : {}),
        ...(input.skills && input.skills.length > 0 ? { keywords: input.skills } : {}),
        recordSet: [{
            '@type':     'cr:RecordSet',
            '@id':       'chunks',
            name:        'chunks',
            description: 'One record per embedded document chunk.',
            field:       chunkFields(),
        }],
    };
}
