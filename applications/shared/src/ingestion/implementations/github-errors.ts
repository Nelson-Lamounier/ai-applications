/**
 * @format
 * Typed errors for the GitHub REST layer. Callers branch on these (instanceof)
 * to turn an HTTP failure into a clear, actionable status instead of crashing
 * on an unexpected response shape.
 */

/** A GitHub repo endpoint returned 404 — renamed away, deleted, or access revoked. */
export class RepoNotFoundError extends Error {
  readonly resource: string;
  constructor(resource: string) {
    super(`GitHub resource not found: ${resource} (repo renamed, deleted, or access revoked)`);
    this.name = 'RepoNotFoundError';
    this.resource = resource;
    // Preserve instanceof across transpile targets that down-level class extends.
    Object.setPrototypeOf(this, RepoNotFoundError.prototype);
  }
}

/** A GitHub response did not match the expected array/object shape (e.g. a redirect body where a list/tree was expected). */
export class GitHubResponseShapeError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, detail: string) {
    super(`GitHub API ${endpoint} returned an unexpected shape: ${detail}`);
    this.name = 'GitHubResponseShapeError';
    this.endpoint = endpoint;
    Object.setPrototypeOf(this, GitHubResponseShapeError.prototype);
  }
}
