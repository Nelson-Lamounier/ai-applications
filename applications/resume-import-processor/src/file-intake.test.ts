/**
 * @format
 */

import { Readable } from 'node:stream';
import { describe, it, expect, jest } from '@jest/globals';

import {
  fetchFileFromS3,
  loadResumeImportFileMetadata,
  resolveSupportedResumeContentType,
} from './file-intake.js';

describe('resolveSupportedResumeContentType', () => {
  it('accepts only PDF and DOCX content types', () => {
    expect(resolveSupportedResumeContentType('application/pdf')).toBe('pdf');
    expect(resolveSupportedResumeContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(() => resolveSupportedResumeContentType('text/plain')).toThrow(/unsupported/i);
  });
});

describe('fetchFileFromS3', () => {
  it('rejects when S3 ContentLength exceeds the configured cap before buffering', async () => {
    const s3 = {
      send: jest.fn(async () => ({
        ContentLength: 2_000,
        Body: Readable.from([Buffer.from('small')]),
      })),
    };

    await expect(
      fetchFileFromS3(s3 as never, 'bucket', 'resume.pdf', { maxBytes: 1_000 }),
    ).rejects.toThrow(/resume_file_too_large/i);
  });

  it('aborts streaming when ContentLength is missing and streamed bytes exceed the cap', async () => {
    const s3 = {
      send: jest.fn(async () => ({
        Body: Readable.from([Buffer.alloc(600), Buffer.alloc(600)]),
      })),
    };

    await expect(
      fetchFileFromS3(s3 as never, 'bucket', 'resume.pdf', { maxBytes: 1_000 }),
    ).rejects.toThrow(/resume_file_too_large/i);
  });

  it('rejects when the database file size disagrees with S3 ContentLength', async () => {
    const s3 = {
      send: jest.fn(async () => ({
        ContentLength: 900,
        Body: Readable.from([Buffer.alloc(900)]),
      })),
    };

    await expect(
      fetchFileFromS3(s3 as never, 'bucket', 'resume.pdf', { maxBytes: 1_000, expectedSizeBytes: 901 }),
    ).rejects.toThrow(/resume_file_size_mismatch/i);
  });
});

describe('loadResumeImportFileMetadata', () => {
  it('loads content type and expected byte size from resume_imports', async () => {
    const pool = {
      query: jest.fn(async () => ({
        rows: [{
          content_type: 'application/pdf',
          file_size_bytes: 1234,
        }],
      })),
    };

    await expect(loadResumeImportFileMetadata(pool as never, 'import-id')).resolves.toEqual({
      contentType: 'application/pdf',
      fileSizeBytes: 1234,
    });
  });
});
