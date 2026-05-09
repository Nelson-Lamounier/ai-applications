/**
 * @format
 * PDF text extractor.
 *
 * Tries pdf-parse first (fast, no network). Falls back to AWS Textract async
 * OCR when the PDF is image-only (no embedded text layer). Textract handles
 * scanned/rendered PDFs regardless of size; the S3 key + bucket are passed
 * directly rather than re-uploading the buffer.
 *
 * Returns the raw text. The caller (extract-career.ts) passes this to Bedrock.
 */
import pdfParse from 'pdf-parse';
import {
  TextractClient,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  type Block,
} from '@aws-sdk/client-textract';

const POLL_INTERVAL_MS  = 2_000;
const POLL_MAX_ATTEMPTS = 60; // 2 min ceiling

async function extractViaTextract(
  bucket: string,
  s3Key: string,
  region: string,
): Promise<string> {
  const client = new TextractClient({ region });

  const { JobId } = await client.send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: { S3Object: { Bucket: bucket, Name: s3Key } },
    }),
  );
  if (!JobId) throw new Error('Textract StartDocumentTextDetection returned no JobId');

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const resp = await client.send(
      new GetDocumentTextDetectionCommand({ JobId }),
    );

    if (resp.JobStatus === 'FAILED') {
      throw new Error(`Textract job failed: ${resp.StatusMessage ?? 'unknown reason'}`);
    }

    if (resp.JobStatus === 'SUCCEEDED') {
      const lines = (resp.Blocks ?? [])
        .filter((b: Block) => b.BlockType === 'LINE' && b.Text)
        .map((b: Block) => b.Text as string);

      // Handle pagination — Textract may return multiple pages of results
      let nextToken = resp.NextToken;
      while (nextToken) {
        const page = await client.send(
          new GetDocumentTextDetectionCommand({ JobId, NextToken: nextToken }),
        );
        (page.Blocks ?? [])
          .filter((b: Block) => b.BlockType === 'LINE' && b.Text)
          .forEach((b: Block) => lines.push(b.Text as string));
        nextToken = page.NextToken;
      }

      const text = lines.join('\n').trim();
      if (!text) throw new Error('Textract extracted no text from PDF');
      return text;
    }
    // JobStatus === 'IN_PROGRESS' — keep polling
  }

  throw new Error(`Textract job did not complete within ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}

// Minimum character count for pdf-parse output to be considered usable.
// PDFs with font-encoding issues produce partial or garbled output that
// passes the non-empty check but has too few meaningful characters to
// yield career data from Bedrock. 200 chars is a safe lower bound for
// any real single-page resume section.
const MIN_USEFUL_TEXT_CHARS = 200;

/**
 * @param buffer      - File bytes fetched from S3.
 * @param s3Key       - Original S3 key (used by Textract OCR fallback).
 * @param bucket      - S3 bucket name (used by Textract OCR fallback).
 * @param awsRegion   - AWS region for the Textract client.
 */
export async function extractTextFromPdf(
  buffer: Buffer,
  s3Key: string,
  bucket: string,
  awsRegion: string,
): Promise<{ text: string; method: 'pdf-parse' | 'textract' }> {
  let pdfText = '';

  try {
    const parsed = await pdfParse(buffer);
    pdfText = parsed.text.trim();
  } catch (err) {
    // pdf-parse throws on encrypted PDFs, malformed structures, and certain
    // CIDFont/XFA documents. Fall through to Textract rather than crashing.
    console.warn('[run-import] pdf-parse threw, falling back to Textract OCR', { s3Key, err });
  }

  if (pdfText.length >= MIN_USEFUL_TEXT_CHARS) {
    return { text: pdfText, method: 'pdf-parse' };
  }

  if (pdfText.length > 0) {
    console.info(
      '[run-import] pdf-parse returned too little text, falling back to Textract OCR',
      { s3Key, chars: pdfText.length },
    );
  } else {
    console.info('[run-import] pdf-parse found no text, falling back to Textract OCR', { s3Key });
  }

  const ocrText = await extractViaTextract(bucket, s3Key, awsRegion);
  return { text: ocrText, method: 'textract' };
}
