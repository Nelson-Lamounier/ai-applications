/**
 * @format
 * Maps an ingestion failure to a short, user-facing status message persisted to
 * repo_sync_state. Pure + import-safe (run-ingestion.ts runs main() on import,
 * so this lives separately to stay testable).
 */
import { RepoNotFoundError, GitHubResponseShapeError } from '@bedrock/shared';
import { ProfileExtractionError } from './agents/ProfileExtractor.js';

export function friendlyIngestionError(err: unknown): string {
  if (err instanceof RepoNotFoundError) {
    return "This repository couldn't be found on GitHub — it may have been renamed, deleted, or access revoked. Reconnect it and try again.";
  }
  if (err instanceof GitHubResponseShapeError) {
    return "GitHub returned an unexpected response for this repository. Please try again in a few minutes.";
  }
  if (err instanceof ProfileExtractionError) {
    if (err.code === 'bedrock_error') {
      return "We couldn't analyze this repository right now. Please try again in a few minutes.";
    }
    return "We couldn't build a profile for this repository. Please try again.";
  }
  return "Indexing didn't finish for this repository. Please try again.";
}
