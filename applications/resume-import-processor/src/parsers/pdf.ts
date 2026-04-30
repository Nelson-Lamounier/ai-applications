/**
 * @format
 * PDF text extractor — wraps pdf-parse for resume text extraction.
 *
 * Returns the raw text content of the PDF. The caller (extract-career.ts)
 * passes this text to Bedrock for structured data extraction.
 */
import pdfParse from 'pdf-parse';

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  const text = result.text.trim();
  if (!text) throw new Error('PDF contains no extractable text (may be image-only)');
  return text;
}
