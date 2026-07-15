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
import { PDFParse } from 'pdf-parse';
import {
  TextractClient,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  type Block,
} from '@aws-sdk/client-textract';
import { jobLogger } from '@bedrock/shared';

const log = jobLogger();

const POLL_INTERVAL_MS  = 2_000;
const POLL_MAX_ATTEMPTS = 60; // 2 min ceiling

// Minimum chars for Textract OCR output to be considered usable.
// Below this, OCR likely failed to recognise the document (encrypted scan,
// non-Latin glyphs without language hints, or pure-image PDF with no text).
const MIN_OCR_TEXT_CHARS = 200;

// Minimum ratio of alphabetic characters in OCR output.
// Garbled OCR returns long strings of symbols/punctuation that pass the
// length check but yield nothing useful to Bedrock — the extractor will
// hallucinate empty fields rather than fail loudly.
const MIN_OCR_ALPHA_RATIO = 0.5;

function assertTextractTextUsable(text: string): void {
  if (text.length === 0) {
    throw new Error('Textract extracted no text from PDF');
  }
  if (text.length < MIN_OCR_TEXT_CHARS) {
    throw new Error(
      `Textract output below usable floor: ${text.length} chars < ${MIN_OCR_TEXT_CHARS}`,
    );
  }
  const alphaCount = (text.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  const ratio = alphaCount / text.length;
  if (ratio < MIN_OCR_ALPHA_RATIO) {
    throw new Error(
      `Textract output alpha ratio ${ratio.toFixed(2)} below floor ${MIN_OCR_ALPHA_RATIO} — likely garbled OCR`,
    );
  }
}

async function extractViaTextract(
  bucket: string,
  s3Key: string,
  region: string,
): Promise<string> {
  const { textractDurationSeconds } = await import('../metrics.js');
  const stop = textractDurationSeconds().startTimer();
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
      stop();
      assertTextractTextUsable(text);
      return text;
    }
    // JobStatus === 'IN_PROGRESS' — keep polling
  }

  stop();
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

  let fallbackReason: 'threw' | 'empty' | 'short_text' | null = null;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const parsed = await parser.getText();
    pdfText = (parsed.text ?? '').trim();
  } catch (err) {
    // pdf-parse throws on encrypted PDFs, malformed structures, and certain
    // CIDFont/XFA documents. Fall through to Textract rather than crashing.
    fallbackReason = 'threw';
    log.warn({ event: 'pdf_parse.fallback', reason: 'threw', s3Key, err: (err as Error).message },
      'pdf-parse threw, falling back to Textract OCR');
  } finally {
    // Release the underlying pdf.js document worker; a destroy failure must
    // not mask a successful extraction or the Textract fallback path.
    await parser.destroy().catch(() => undefined);
  }

  if (pdfText.length >= MIN_USEFUL_TEXT_CHARS) {
    return { text: pdfText, method: 'pdf-parse' };
  }

  if (pdfText.length > 0) {
    fallbackReason ??= 'short_text';
    log.info({ event: 'pdf_parse.fallback', reason: 'short_text', s3Key, chars: pdfText.length },
      'pdf-parse returned too little text, falling back to Textract OCR');
  } else {
    fallbackReason ??= 'empty';
    log.info({ event: 'pdf_parse.fallback', reason: 'empty', s3Key },
      'pdf-parse found no text, falling back to Textract OCR');
  }

  const { textractFallbackTotal } = await import('../metrics.js');
  textractFallbackTotal().inc({ reason: fallbackReason });

  const ocrText = await extractViaTextract(bucket, s3Key, awsRegion);
  return { text: ocrText, method: 'textract' };
}
