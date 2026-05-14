/**
 * Integration test — real AWS Textract.
 *
 * Uploads the fixture PDF to S3, runs extractTextFromPdf against live AWS,
 * then deletes the S3 object. No mocks. Requires valid AWS credentials and
 * S3/Textract permissions in the target account.
 *
 * Run:
 *   AWS_REGION=eu-west-1 \
 *   ASSETS_BUCKET=bedrock-data-development-assetsbucket5cb76180-fnnkzihpuz3y \
 *   npx jest --config applications/jest.config.js \
 *     --testPathPattern="pdf.integration.test" \
 *     --rootDir applications/resume-import-processor \
 *     --testTimeout=180000
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { extractTextFromPdf } from '../pdf';

const REGION = process.env['AWS_REGION'] ?? 'eu-west-1';
const BUCKET = process.env['ASSETS_BUCKET'] ?? 'bedrock-data-development-assetsbucket5cb76180-fnnkzihpuz3y';
const S3_KEY = `test/pdf-integration-${Date.now()}/Nelson_Lamounier_Resume.pdf`;
const FIXTURE = path.join(__dirname, 'fixtures/Nelson_Lamounier_Resume.pdf');

const s3 = new S3Client({ region: REGION });

beforeAll(async () => {
  const body = fs.readFileSync(FIXTURE);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: S3_KEY,
    Body: body,
    ContentType: 'application/pdf',
  }));
  console.log(`[integration] uploaded to s3://${BUCKET}/${S3_KEY}`);
});

afterAll(async () => {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: S3_KEY }));
  console.log(`[integration] deleted s3://${BUCKET}/${S3_KEY}`);
});

describe('extractTextFromPdf — live AWS Textract', () => {
  // Textract async jobs typically complete in 15-60s; allow 3 min
  jest.setTimeout(180_000);

  it('extracts text from the image-based resume via Textract', async () => {
    const pdfBuffer = fs.readFileSync(FIXTURE);

    const { text, method } = await extractTextFromPdf(pdfBuffer, S3_KEY, BUCKET, REGION);

    console.log(`[integration] method=${method} chars=${text.length}`);
    console.log('[integration] first 500 chars:\n', text.slice(0, 500));

    expect(method).toBe('textract');
    expect(text.length).toBeGreaterThan(200);
    // Name should appear somewhere in the extracted text
    expect(text.toLowerCase()).toMatch(/nelson/i);
  });
});
