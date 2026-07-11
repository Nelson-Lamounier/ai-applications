/**
 * @format
 */
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { hydrateRdsEnv } from './hydrate-rds-env.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- aws-sdk-client-mock@4 vs @aws-sdk/client-*@3.1001 type mismatch; the repo's KMS test uses the same `as any` shim.
const ssmMock: any = mockClient(SSMClient as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
const smMock: any = mockClient(SecretsManagerClient as any);

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
            SecretString: JSON.stringify({ username: 'postgres', password: 'pw-test-fixture' }),
        });

        await hydrateRdsEnv();

        expect(process.env['RDS_HOST']).toBe('db-host-iso.clkke.eu-west-1.rds.amazonaws.com');
        expect(process.env['RDS_PASSWORD']).toBe('pw-test-fixture');
        // Reads the host from `${prefix}/host`.
        expect(ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input).toMatchObject({
            Name: '/k8s/development/platform-rds/host',
        });
    });
});
