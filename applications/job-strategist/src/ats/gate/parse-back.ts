/** @format */
import { PDFParse } from 'pdf-parse';

/** Standard ATS section headers we expect a parseable resume to expose. */
export const STANDARD_SECTIONS = ['Summary', 'Experience', 'Skills', 'Projects', 'Education', 'Certifications'] as const;

export interface ParsedPdf {
    readonly text: string;
    readonly sections: string[];
    /** Rendered page count — the ground truth for the 2-page limit. */
    readonly pages: number;
}

/**
 * Extract text from a rendered PDF and detect which standard headers survived.
 * Uses pdf-parse v2's PDFParse class (dual CJS/ESM package — safe to import in
 * this CommonJS workspace).
 */
export async function parsePdfBack(buf: Buffer): Promise<ParsedPdf> {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const result = await parser.getText();
        const text = result.text ?? '';
        const sections = STANDARD_SECTIONS.filter(h =>
            new RegExp(`(^|\\n)\\s*${h}\\s*(\\n|$)`, 'i').test(text),
        );
        return { text, sections, pages: result.total ?? 0 };
    } finally {
        await parser.destroy();
    }
}
