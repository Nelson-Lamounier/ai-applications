/**
 * @format
 * Typed errors for the GitHub REST layer. Callers branch on these (instanceof)
 * to turn an HTTP failure into a clear, actionable status instead of crashing
 * on an unexpected response shape.
 */

/**
 * A GitHub endpoint returned 404. This is raised for BOTH a repo-level miss
 * (the repository was renamed, deleted, or access was revoked) AND a
 * resource-level miss (a specific file/path simply does not exist in the repo
 * — a perfectly normal outcome when probing for optional manifests).
 *
 * The message no longer asserts the repo is gone: a 404 on `contents/go.mod`
 * means that file is absent, not that the repository vanished. Callers that
 * probe optional paths should catch this by type (`instanceof`) and treat it
 * as "absent", rather than logging it as a failure.
 */
export class RepoNotFoundError extends Error {
  readonly resource: string;
  constructor(resource: string) {
    super(`GitHub resource not found: ${resource} (path absent, or repo renamed/deleted/inaccessible)`);
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
