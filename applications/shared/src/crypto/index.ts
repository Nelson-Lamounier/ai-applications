// applications/shared/src/crypto/index.ts
export {
    createKmsEnvelope,
    KmsEnvelopeError,
    IntegrityError,
} from './kmsEnvelope.js';
export type { KmsEnvelope, EncryptedPayload } from './kmsEnvelope.js';
