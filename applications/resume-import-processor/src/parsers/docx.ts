/**
 * @format
 * DOCX text extractor — wraps mammoth for resume text extraction.
 *
 * Uses extractRawText (not HTML conversion) to get clean plain text
 * without table/bullet markup that would confuse the extraction prompt.
 */
import mammoth from 'mammoth';

export async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();
  if (!text) throw new Error('DOCX contains no extractable text');
  return text;
}
