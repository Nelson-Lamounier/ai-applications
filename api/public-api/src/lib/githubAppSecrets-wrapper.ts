/**
 * @file githubAppSecrets-wrapper.ts
 * @description Public-api Config adapter for the shared
 * getGitHubAppSecrets fetcher.
 */

import { getGitHubAppSecrets as getFromShared } from '@bedrock/shared';
import type { GitHubAppSecrets } from '@bedrock/shared';
import type { Config } from './config.js';

export async function getGitHubAppSecrets(config: Config): Promise<GitHubAppSecrets> {
    return getFromShared({
        secretArn: config.githubAppSecretArn,
        region:    config.awsRegion,
    });
}

export { __resetGitHubAppSecretsCacheForTests } from '@bedrock/shared';
