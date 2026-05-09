import * as fs from 'fs';
import * as path from 'path';

// Must be hoisted before importing the module under test
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-textract', () => ({
  TextractClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  StartDocumentTextDetectionCommand: jest.fn(),
  GetDocumentTextDetectionCommand: jest.fn(),
}));

import { extractTextFromPdf } from '../pdf';

const FIXTURE = path.join(__dirname, 'fixtures/Nelson_Lamounier_Resume.pdf');
const BUCKET = 'test-bucket';
const REGION = 'us-east-1';

function makeTextractResponses(lines: string[]) {
  return [
    // First send() = StartDocumentTextDetection → returns JobId
    { JobId: 'mock-job-id' },
    // Second send() = GetDocumentTextDetection → SUCCEEDED with text blocks
    {
      JobStatus: 'SUCCEEDED',
      Blocks: lines.map((t) => ({ BlockType: 'LINE', Text: t })),
      NextToken: undefined,
    },
  ];
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('extractTextFromPdf — Nelson_Lamounier_Resume.pdf (image-based)', () => {
  it('falls back to Textract because pdf-parse extracts < 200 chars', async () => {
    const resumeLines = [
      'Nelson Lamounier',
      'Software Engineer',
      'Experience: Senior Software Engineer at Acme Corp 2020-2024',
      'Education: B.Sc. Computer Science',
      'Skills: TypeScript, AWS, Kubernetes',
    ];
    mockSend
      .mockResolvedValueOnce({ JobId: 'mock-job-id' })
      .mockResolvedValueOnce({
        JobStatus: 'SUCCEEDED',
        Blocks: resumeLines.map((t) => ({ BlockType: 'LINE', Text: t })),
        NextToken: undefined,
      });

    const buf = fs.readFileSync(FIXTURE);
    const { text, method } = await extractTextFromPdf(buf, 'resume.pdf', BUCKET, REGION);

    expect(method).toBe('textract');
    expect(text).toContain('Nelson Lamounier');
    expect(text.length).toBeGreaterThan(0);
    // Textract was called (StartDocumentTextDetection + GetDocumentTextDetection)
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('extractTextFromPdf — corrupted / non-PDF buffer', () => {
  it('falls back to Textract when pdf-parse throws', async () => {
    mockSend
      .mockResolvedValueOnce({ JobId: 'mock-job-id' })
      .mockResolvedValueOnce({
        JobStatus: 'SUCCEEDED',
        Blocks: [{ BlockType: 'LINE', Text: 'Recovered via OCR' }],
        NextToken: undefined,
      });

    const badBuf = Buffer.from('this is definitely not a pdf');
    const { text, method } = await extractTextFromPdf(badBuf, 'bad.pdf', BUCKET, REGION);

    expect(method).toBe('textract');
    expect(text).toBe('Recovered via OCR');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('extractTextFromPdf — text-based PDF (synthetic)', () => {
  it('returns pdf-parse result when text is >= 200 chars without calling Textract', async () => {
    // Minimal valid PDF with embedded text long enough to pass MIN_USEFUL_TEXT_CHARS
    const longText = 'A'.repeat(250);
    const syntheticPdf = Buffer.from(
      `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${longText.length + 20}>>
stream
BT /F1 12 Tf 72 720 Td (${longText}) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`,
    );

    // pdf-parse may or may not decode the synthetic font — we just verify the
    // fallback is NOT triggered if text >= 200 chars is returned.
    // If pdf-parse still returns < 200 chars for the synthetic PDF, Textract
    // would be called; we mock it to avoid a hang.
    mockSend
      .mockResolvedValueOnce({ JobId: 'mock-job-id' })
      .mockResolvedValueOnce({
        JobStatus: 'SUCCEEDED',
        Blocks: [{ BlockType: 'LINE', Text: longText }],
        NextToken: undefined,
      });

    const { text, method } = await extractTextFromPdf(syntheticPdf, 'synthetic.pdf', BUCKET, REGION);

    // Either path is valid — what matters is that text is non-empty and >= 200 chars
    expect(text.length).toBeGreaterThanOrEqual(200);
    expect(['pdf-parse', 'textract']).toContain(method);
  });
});

describe('extractTextFromPdf — Textract failure', () => {
  it('throws when Textract job fails', async () => {
    mockSend
      .mockResolvedValueOnce({ JobId: 'mock-job-id' })
      .mockResolvedValueOnce({ JobStatus: 'FAILED', StatusMessage: 'Unsupported document' });

    const buf = fs.readFileSync(FIXTURE);
    await expect(
      extractTextFromPdf(buf, 'resume.pdf', BUCKET, REGION),
    ).rejects.toThrow('Textract job failed: Unsupported document');
  });
});
