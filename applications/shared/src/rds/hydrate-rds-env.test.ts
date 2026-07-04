/**
 * @format
 */
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { hydrateRdsEnv } from './hydrate-rds-env.js';

const ssmMock = mockClient(SSMClient as never);
const smMock  = mockClient(SecretsManagerClient as never);

describe('hydrateRdsEnv', () => {
    it('resolves RDS_HOST from SSM and RDS_PASSWORD from Secrets Manager onto process.env', async () => {
        process.env['RDS_SSM_PREFIX']  = '/k8s/development/platform-rds';
        process.env['RDS_SECRET_NAME'] = 'k8s-development/platform-rds/credentials';
        delete process.env['RDS_HOST'];
        delete process.env['RDS_PASSWORD'];

        ssmMock.on(GetParameterCommand).resolves({
            Parameter: { Value: 'db-host-iso.clkke.eu-west-1.rds.amazonaws.com' },
        });
        smMock.on(GetSecretValueCommand).resolves({
            SecretString: JSON.stringify({ username: 'postgres', password: 's3cret-pw' }),
        });

        await hydrateRdsEnv();

        expect(process.env['RDS_HOST']).toBe('db-host-iso.clkke.eu-west-1.rds.amazonaws.com');
        expect(process.env['RDS_PASSWORD']).toBe('s3cret-pw');
        // Reads the host from `${prefix}/host`.
        expect(ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input).toMatchObject({
            Name: '/k8s/development/platform-rds/host',
        });
    });
});
