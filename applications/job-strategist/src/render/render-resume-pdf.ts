/** @format */
import type { StructuredResumeData } from '@bedrock/shared';

import { loadReactPdf } from './react-pdf.js';
import { buildResumeElement } from './resume-pdf/build-resume-element.js';

/** Render the AI-authored resume to a text-selectable PDF buffer (Node, no browser). */
export async function renderResumePdf(data: StructuredResumeData): Promise<Buffer> {
    const rp = await loadReactPdf();
    return rp.renderToBuffer(buildResumeElement(rp, data));
}
