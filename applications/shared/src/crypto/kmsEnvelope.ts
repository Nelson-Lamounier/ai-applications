// applications/shared/src/crypto/kmsEnvelope.ts
/**
 * AES-256-GCM envelope encryption backed by AWS KMS.
 *
 * Each call to `encrypt` requests a fresh data key from KMS, uses it once,
 * and zeroes the plaintext key buffer. The encrypted DEK is stored alongside
 * the ciphertext. Decryption asks KMS to unwrap the DEK, then performs
 * AES-256-GCM with the supplied IV and auth tag.
 *
 * The optional `ctx` parameter is passed to KMS as EncryptionContext (AAD).
 * Callers MUST supply the same context on decrypt or KMS refuses. Use this
 * to bind ciphertext to its row (e.g. `{ user_id, provider }`).
 */

import {
    KMSClient,
    GenerateDataKeyCommand,
    DecryptCommand,
} from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedPayload {
    ciphertext: Buffer;
    dek:        Buffer;
    iv:         Buffer;
    tag:        Buffer;
}

export interface KmsEnvelope {
    encrypt(plaintext: string, ctx?: Record<string, string>): Promise<EncryptedPayload>;
    decrypt(p: EncryptedPayload, ctx?: Record<string, string>): Promise<string>;
}

export class KmsEnvelopeError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'KmsEnvelopeError';
    }
}

export class IntegrityError extends KmsEnvelopeError {
    constructor(message = 'envelope integrity check failed', options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'IntegrityError';
    }
}

export function createKmsEnvelope(opts: {
    kmsClient: KMSClient;
    keyId:     string;
}): KmsEnvelope {
    const { kmsClient, keyId } = opts;

    return {
        async encrypt(plaintext, ctx) {
            let dekPlain: Buffer | undefined;
            try {
                const out = await kmsClient.send(
                    new GenerateDataKeyCommand({
                        KeyId: keyId,
                        KeySpec: 'AES_256',
                        EncryptionContext: ctx,
                    }),
                );
                if (!out.Plaintext || !out.CiphertextBlob) {
                    throw new KmsEnvelopeError('KMS GenerateDataKey returned empty material');
                }
                dekPlain = Buffer.from(out.Plaintext);
                const dekEnc = Buffer.from(out.CiphertextBlob);

                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', dekPlain, iv);
                const ciphertext = Buffer.concat([
                    cipher.update(plaintext, 'utf8'),
                    cipher.final(),
                ]);
                const tag = cipher.getAuthTag();

                return { ciphertext, dek: dekEnc, iv, tag };
            } catch (err) {
                if (err instanceof KmsEnvelopeError) throw err;
                throw new KmsEnvelopeError('encrypt failed', { cause: err });
            } finally {
                if (dekPlain) dekPlain.fill(0);
            }
        },

        async decrypt(payload, ctx) {
            let dekPlain: Buffer | undefined;
            try {
                const out = await kmsClient.send(
                    new DecryptCommand({
                        CiphertextBlob: payload.dek,
                        EncryptionContext: ctx,
                    }),
                );
                if (!out.Plaintext) {
                    throw new KmsEnvelopeError('KMS Decrypt returned empty plaintext');
                }
                dekPlain = Buffer.from(out.Plaintext);

                const decipher = createDecipheriv('aes-256-gcm', dekPlain, payload.iv);
                decipher.setAuthTag(payload.tag);
                const plain = Buffer.concat([
                    decipher.update(payload.ciphertext),
                    decipher.final(),
                ]);
                return plain.toString('utf8');
            } catch (err: unknown) {
                if (err instanceof KmsEnvelopeError) throw err;
                // GCM auth failure surfaces as a generic Error from node:crypto.
                const message = (err as any)?.message ?? '';
                if (typeof message === 'string' && /unsupported state|unable to authenticate|auth tag/i.test(message)) {
                    throw new IntegrityError(undefined, { cause: err as Error });
                }
                throw new KmsEnvelopeError('decrypt failed', { cause: err });
            } finally {
                if (dekPlain) dekPlain.fill(0);
            }
        },
    };
}
