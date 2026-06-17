/** @format */
import { describe, it, expect } from '@jest/globals';
import { RepoNotFoundError, GitHubResponseShapeError } from './github-errors.js';

describe('RepoNotFoundError', () => {
  it('is an Error with a stable name and the resource in the message', () => {
    const err = new RepoNotFoundError('/repos/o/r');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RepoNotFoundError);
    expect(err.name).toBe('RepoNotFoundError');
    expect(err.resource).toBe('/repos/o/r');
    expect(err.message).toContain('/repos/o/r');
  });
});

describe('GitHubResponseShapeError', () => {
  it('is an Error naming the endpoint and detail', () => {
    const err = new GitHubResponseShapeError('/repos/o/r/commits', 'expected an array');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GitHubResponseShapeError);
    expect(err.name).toBe('GitHubResponseShapeError');
    expect(err.endpoint).toBe('/repos/o/r/commits');
    expect(err.message).toContain('expected an array');
  });
});
