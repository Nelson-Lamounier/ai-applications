/**
 * @format
 * Ingestion Module — Public API
 *
 * Repo-to-chunk pipeline: list → filter → fetch → chunk → hand to IngestionPipeline.
 *
 * Structure:
 *   interfaces     — IFileFilter, IChunker, IRepoAdapter
 *   implementations — FileFilter, MarkdownChunker, DefaultChunker, ChunkerRegistry, GitHubAdapter
 *   orchestrator   — RepoIngestionOrchestrator (coordinates all four)
 */

// Interfaces
export type { IFileFilter }            from './interfaces/IFileFilter.js';
export type { IChunker }               from './interfaces/IChunker.js';
export type { IRepoAdapter, RepoFile } from './interfaces/IRepoAdapter.js';

// Implementations
export { FileFilter }                  from './implementations/FileFilter.js';
export type { FileFilterConfig }       from './implementations/FileFilter.js';
export { DEFAULT_FILTER_CONFIG }       from './implementations/FileFilter.js';

export { MarkdownChunker }             from './implementations/MarkdownChunker.js';
export type { MarkdownChunkerConfig }  from './implementations/MarkdownChunker.js';

export { CodeChunker }                 from './implementations/CodeChunker.js';
export type { CodeChunkerConfig }      from './implementations/CodeChunker.js';

export { DefaultChunker }              from './implementations/DefaultChunker.js';
export type { DefaultChunkerConfig }   from './implementations/DefaultChunker.js';

export { ChunkerRegistry }             from './implementations/ChunkerRegistry.js';

export { classifyFile }                from './implementations/file-classifier.js';
export type { FileClass }              from './implementations/file-classifier.js';

export { GitHubAdapter }               from './implementations/GitHubAdapter.js';

// Orchestrator
export { RepoIngestionOrchestrator }   from './orchestrator/RepoIngestionOrchestrator.js';
