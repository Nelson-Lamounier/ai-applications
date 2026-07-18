/** @format */
import { describe, it, expect } from '@jest/globals';
import { RepoNotFoundError, GitHubResponseShapeError } from '@bedrock/shared';
import { friendlyIngestionError } from '../friendly-error.js';

describe('friendlyIngestionError', () => {
  it('explains a renamed/missing repo for RepoNotFoundError', () => {
    const msg = friendlyIngestionError(new RepoNotFoundError('/repos/o/r'));
    expect(msg.toLowerCase()).toContain('renamed');
  });

  it('gives a retry message for an unexpected GitHub response shape', () => {
    const msg = friendlyIngestionError(new GitHubResponseShapeError('/repos/o/r/commits', 'x'));
    expect(msg.toLowerCase()).toContain('try again');
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(friendlyIngestionError(new Error('boom'))).toContain("didn't finish");
  });
});
