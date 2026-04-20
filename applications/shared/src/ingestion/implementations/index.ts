/**
 * @format
 * Ingestion Implementations — Barrel Export
 */

export { FileFilter }       from './FileFilter.js';
export type { FileFilterConfig } from './FileFilter.js';
export { DEFAULT_FILTER_CONFIG } from './FileFilter.js';

export { MarkdownChunker }  from './MarkdownChunker.js';
export type { MarkdownChunkerConfig } from './MarkdownChunker.js';

export { DefaultChunker }   from './DefaultChunker.js';
export type { DefaultChunkerConfig } from './DefaultChunker.js';

export { ChunkerRegistry }  from './ChunkerRegistry.js';

export { GitHubAdapter }    from './GitHubAdapter.js';
