/** @format */
import type { StructuredResumeData } from '@bedrock/shared';
import { createElement as h, type ReactElement } from 'react';

import type { ReactPdfPrimitives } from '../react-pdf.js';

// ATS-safe by construction: one column, standard section headers, contact in
// the body (never a header/footer region), no tables, no multi-column rows for
// content, no images, built-in Helvetica so text is always extractable.
function styles(StyleSheet: ReactPdfPrimitives['StyleSheet']) {
    return StyleSheet.create({
        page:     { paddingVertical: 40, paddingHorizontal: 40, fontSize: 10, fontFamily: 'Helvetica', lineHeight: 1.35 },
        name:     { fontSize: 18, fontFamily: 'Helvetica-Bold' },
        title:    { fontSize: 11, marginBottom: 2 },
        contact:  { fontSize: 9, marginBottom: 10 },
        section:  { fontSize: 12, fontFamily: 'Helvetica-Bold', marginTop: 12, marginBottom: 4 },
        item:     { marginBottom: 6 },
        itemHead: { fontFamily: 'Helvetica-Bold' },
        bullet:   { marginLeft: 10, marginBottom: 1 },
        summary:  { marginBottom: 4 },
    });
}

/**
 * Build the @react-pdf element tree for a resume. Uses React.createElement
 * (not JSX) so this CommonJS package never statically imports the ESM-only
 * primitives — they arrive via the dynamically-loaded module.
 */
export function buildResumeElement(rp: ReactPdfPrimitives, data: StructuredResumeData): ReactElement {
    const { Document, Page, Text, View } = rp;
    const s = styles(rp.StyleSheet);
    const p = data.profile;
    const contact = [p.email, p.location, p.linkedin, p.github, p.website].filter(Boolean).join('  •  ');

    const text = (style: unknown, content: string, key?: string): ReactElement =>
        h(Text, key !== undefined ? { style, key } : { style }, content);

    const sectionHeader = (label: string): ReactElement => h(Text, { style: s.section, key: `h-${label}` }, label);

    const children: ReactElement[] = [
        h(Text, { style: s.name, key: 'name' }, p.name),
        h(Text, { style: s.title, key: 'title' }, p.title),
        h(Text, { style: s.contact, key: 'contact' }, contact),
    ];

    if (data.summary) {
        children.push(sectionHeader('Summary'));
        children.push(text(s.summary, data.summary, 'summary'));
    }

    children.push(sectionHeader('Experience'));
    data.experience.forEach((e, i) => {
        children.push(
            h(View, { style: s.item, wrap: false, key: `exp-${i}` }, [
                h(Text, { style: s.itemHead, key: 'head' }, `${e.title} — ${e.company}`),
                h(Text, { key: 'period' }, e.period),
                ...e.highlights.map((hl, j) => h(Text, { style: s.bullet, key: `hl-${j}` }, `• ${hl}`)),
            ]),
        );
    });

    children.push(sectionHeader('Skills'));
    data.skills.forEach((c, i) => children.push(text(s.bullet, `${c.category}: ${c.skills.join(', ')}`, `sk-${i}`)));

    if (data.projects.length) {
        children.push(sectionHeader('Projects'));
        data.projects.forEach((pr, i) => {
            // Always structured: name header, github link, pitch, then any
            // JD-aligned technical bullets (mirrors the Experience layout). The
            // github link is part of the section's trust signal and must show
            // even when a project carries no highlights.
            const highlights = pr.highlights ?? [];
            children.push(
                h(View, { style: s.item, key: `pr-${i}` }, [
                    h(Text, { style: s.itemHead, key: 'head' }, pr.name),
                    ...(pr.github ? [h(Text, { style: s.contact, key: 'gh' }, pr.github)] : []),
                    ...(pr.description ? [h(Text, { key: 'desc' }, pr.description)] : []),
                    ...highlights.map((hl, j) => h(Text, { style: s.bullet, key: `pr-hl-${j}` }, `• ${hl}`)),
                ]),
            );
        });
    }

    children.push(sectionHeader('Education'));
    data.education.forEach((ed, i) =>
        children.push(text(s.bullet, `${ed.degree}, ${ed.institution} (${ed.period})`, `ed-${i}`)),
    );

    if (data.certifications.length) {
        children.push(sectionHeader('Certifications'));
        data.certifications.forEach((ct, i) =>
            children.push(text(s.bullet, `${ct.name} — ${ct.issuer} (${ct.year})`, `ct-${i}`)),
        );
    }

    return h(Document, null, h(Page, { size: 'A4', style: s.page }, children));
}
