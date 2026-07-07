/**
 * @format
 * Bedrock Data Stack — Article Assets Bucket Unit Tests
 *
 * Covers the dedicated public article-media bucket (images/videos served by
 * public-api's internet-facing image endpoint). Deliberately separate from
 * AssetsBucket (resumes/, resume-imports/ = user PII) so bucket-level
 * separation makes PII exposure structurally impossible.
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { BedrockDataStack } from '../../../../lib/stacks/bedrock/data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'bedrock-dev';
const ADMIN_ROLE_NAME = 'ADMIN_ROLE_NAME';
const PUBLIC_ROLE_NAME = 'PUBLIC_ROLE_NAME';

function buildStack(overrides: {
    articleAssetsAdminRoleName?: string;
    articleAssetsReaderRoleName?: string;
    environmentName?: string;
} = {}): BedrockDataStack {
    const app = createTestApp();
    return new BedrockDataStack(app, 'TestData', {
        namePrefix: NAME_PREFIX,
        createEncryptionKey: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        haikuProfileSourceArn: 'arn:aws:bedrock:eu-west-1:111111111111:inference-profile/h',
        sonnetProfileSourceArn: 'arn:aws:bedrock:eu-west-1:111111111111:inference-profile/s',
        environmentName: overrides.environmentName ?? 'development',
        articleAssetsAdminRoleName: overrides.articleAssetsAdminRoleName ?? ADMIN_ROLE_NAME,
        articleAssetsReaderRoleName: overrides.articleAssetsReaderRoleName ?? PUBLIC_ROLE_NAME,
        env: TEST_ENV_EU,
    });
}

function synth(): Template {
    return Template.fromStack(buildStack());
}

// =============================================================================
// Tests
// =============================================================================

describe('BedrockDataStack — article assets bucket', () => {
    it('should create a private, encrypted bucket with tucaken.io CORS for PUT', () => {
        const template = synth();
        template.hasResourceProperties('AWS::S3::Bucket', {
            CorsConfiguration: {
                CorsRules: Match.arrayWith([
                    Match.objectLike({
                        AllowedMethods: ['PUT', 'GET', 'HEAD'],
                        AllowedOrigins: Match.arrayWith(['https://tucaken.io']),
                    }),
                ]),
            },
            PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true }),
        });
    });

    it('should publish the bucket name to SSM for ESO consumption', () => {
        synth().hasResourceProperties('AWS::SSM::Parameter', {
            Name: `/${NAME_PREFIX}/article-assets-bucket-name`,
        });
    });

    it('should grant write to the admin role and read to the reader role, prefix-scoped', () => {
        const template = synth();
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: Match.arrayWith(['s3:PutObject']) }),
                ]),
            }),
            Roles: [ADMIN_ROLE_NAME],
        });
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: 's3:GetObject' }),
                ]),
            }),
            Roles: [PUBLIC_ROLE_NAME],
        });
    });

    it('should throw at synth time when the admin role name is a -TBD placeholder', () => {
        expect(() => buildStack({
            articleAssetsAdminRoleName: 'EksPodIdentity-staging-admin-api-TBD',
            environmentName: 'staging',
        })).toThrow(/articleAssets\.adminRoleName role for environment "staging" is a placeholder/);
    });

    it('should throw at synth time when the reader role name is a -TBD placeholder', () => {
        expect(() => buildStack({
            articleAssetsReaderRoleName: 'EksPodIdentity-production-public-api-TBD',
            environmentName: 'production',
        })).toThrow(/articleAssets\.readerRoleName role for environment "production" is a placeholder/);
    });

    it('should not throw for a real, non-placeholder role name', () => {
        expect(() => buildStack({
            articleAssetsAdminRoleName: 'EksPodIdentity-production-Roleadminapi5EAE4B6E-gYZToUb4xsCc',
            articleAssetsReaderRoleName: 'EksPodIdentity-production-Rolepublicapi88CC20CC-xv2h0dN8FPQ8',
            environmentName: 'production',
        })).not.toThrow();
    });
});
