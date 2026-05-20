// applications/shared/src/crypto/kmsEnvelope.test.ts
import { mockClient } from 'aws-sdk-client-mock';
import {
    KMSClient,
    GenerateDataKeyCommand,
    DecryptCommand,
} from '@aws-sdk/client-kms';
import { randomBytes } from 'node:crypto';
import { createKmsEnvelope } from './kmsEnvelope.js';

// Cast around a known structural-type mismatch between the @smithy/types
// versions resolved at the top level vs. nested under @aws-sdk/client-kms
// (4.14.1 vs 4.14.2). Behaviour is unaffected.
/* eslint-disable @typescript-eslint/no-explicit-any */
const kmsMock: any = mockClient(KMSClient as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => kmsMock.reset());

test('encrypt → decrypt roundtrip returns original plaintext', async () => {
    const dekPlain = randomBytes(32);
    const dekEnc = Buffer.from('fake-kms-ciphertext');

    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: dekEnc,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: dekPlain });

    const env = createKmsEnvelope({
        kmsClient: new KMSClient({}),
        keyId: 'alias/test',
    });

    const payload = await env.encrypt('ghp_secret_token', {
        user_id: 'u1',
        provider: 'github',
    });
    const out = await env.decrypt(payload, {
        user_id: 'u1',
        provider: 'github',
    });

    expect(out).toBe('ghp_secret_token');
});
