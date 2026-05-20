// applications/shared/src/crypto/kmsEnvelope.test.ts
import { mockClient } from 'aws-sdk-client-mock';
import {
    KMSClient,
    GenerateDataKeyCommand,
    DecryptCommand,
} from '@aws-sdk/client-kms';
import { randomBytes } from 'node:crypto';
import { createKmsEnvelope, KmsEnvelopeError, IntegrityError } from './kmsEnvelope.js';

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

test('tampered ciphertext byte → IntegrityError', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: dekPlain });

    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });
    const p = await env.encrypt('hello');
    p.ciphertext[0] ^= 0xff; // flip a byte

    await expect(env.decrypt(p)).rejects.toBeInstanceOf(IntegrityError);
});

test('tampered tag → IntegrityError', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: dekPlain });

    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });
    const p = await env.encrypt('hello');
    p.tag[0] ^= 0xff;

    await expect(env.decrypt(p)).rejects.toBeInstanceOf(IntegrityError);
});

test('fresh IV per call — same plaintext encrypts to different ciphertext', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });

    const a = await env.encrypt('same');
    const b = await env.encrypt('same');

    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
});

test('KMS Decrypt failure surfaces wrapped error with cause', async () => {
    const dekPlain = randomBytes(32);
    kmsMock.on(GenerateDataKeyCommand).resolves({
        Plaintext: dekPlain,
        CiphertextBlob: Buffer.from('enc'),
    });
    const env = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId: 'k' });
    const p = await env.encrypt('hello');

    kmsMock.on(DecryptCommand).rejects(new Error('InvalidCiphertextException'));
    await expect(env.decrypt(p)).rejects.toBeInstanceOf(KmsEnvelopeError);
});
