/**
 * @format
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';

export type SupportedResumeFileKind = 'pdf' | 'docx';

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DEFAULT_MAX_RESUME_FILE_BYTES = Number(process.env.MAX_RESUME_FILE_BYTES ?? 10 * 1024 * 1024);

export interface FetchFileFromS3Options {
  maxBytes?: number;
  expectedSizeBytes?: number;
}

export interface ResumeImportFileMetadata {
  contentType?: string;
  fileSizeBytes?: number;
}

function normaliseContentType(contentType: string): string {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

export function resolveSupportedResumeContentType(contentType: string): SupportedResumeFileKind {
  const normalised = normaliseContentType(contentType);
  if (normalised === 'application/pdf') return 'pdf';
  if (normalised === DOCX_CONTENT_TYPE) return 'docx';
  throw new Error(`unsupported_resume_content_type: ${contentType}`);
}

function assertSizeWithinLimit(sizeBytes: number, maxBytes: number): void {
  if (sizeBytes > maxBytes) {
    throw new Error(`resume_file_too_large: ${sizeBytes} > ${maxBytes}`);
  }
}

function assertExpectedSize(actualBytes: number, expectedSizeBytes?: number): void {
  if (expectedSizeBytes !== undefined && actualBytes !== expectedSizeBytes) {
    throw new Error(`resume_file_size_mismatch: s3=${actualBytes} db=${expectedSizeBytes}`);
  }
}

export async function fetchFileFromS3(
  s3: S3Client,
  bucket: string,
  key: string,
  options: FetchFileFromS3Options = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESUME_FILE_BYTES;
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  if (typeof response.ContentLength === 'number') {
    assertSizeWithinLimit(response.ContentLength, maxBytes);
    assertExpectedSize(response.ContentLength, options.expectedSizeBytes);
  }

  const stream = response.Body as AsyncIterable<Uint8Array | string> | undefined;
  if (!stream) throw new Error('resume_file_missing_body');

  const chunks: Uint8Array[] = [];
  let streamedBytes = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    streamedBytes += bytes.byteLength;
    assertSizeWithinLimit(streamedBytes, maxBytes);
    chunks.push(bytes);
  }

  assertExpectedSize(streamedBytes, options.expectedSizeBytes);
  return Buffer.concat(chunks);
}

export async function loadResumeImportFileMetadata(
  pool: Pool,
  importId: string,
): Promise<ResumeImportFileMetadata> {
  const { rows } = await pool.query<{
    content_type: string | null;
    file_size_bytes: number | string | null;
  }>(
    `SELECT content_type, file_size_bytes
       FROM resume_imports
      WHERE id = $1::uuid`,
    [importId],
  );

  const row = rows[0];
  if (!row) return {};

  const fileSizeBytes = row.file_size_bytes === null || row.file_size_bytes === undefined
    ? undefined
    : Number(row.file_size_bytes);

  return {
    contentType: row.content_type ?? undefined,
    fileSizeBytes: Number.isFinite(fileSizeBytes) ? fileSizeBytes : undefined,
  };
}
