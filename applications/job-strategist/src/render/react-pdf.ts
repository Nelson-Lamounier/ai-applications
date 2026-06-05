/** @format */
import type { ReactElement } from 'react';

// @react-pdf/renderer v4 is pure ESM, but this package compiles to CommonJS.
// A static import (or a transpiler-down-levelled dynamic import) becomes
// require() at runtime and throws ERR_REQUIRE_ESM. The Function-wrapped
// import() below is invisible to both tsc (NodeNext) and ts-jest, so it stays
// a real dynamic import that Node's CommonJS runtime can use to load ESM.
// SAFETY: the Function body is a fixed string literal with no interpolation;
// `specifier` is a by-value parameter and is only ever called with the
// hardcoded module name below — there is no injection surface.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
) => Promise<unknown>;

// In @react-pdf/renderer v4 the primitives are string element tags (e.g.
// 'DOCUMENT', 'PAGE'), not function components — they are passed as the type
// argument to React.createElement. StyleSheet is a plain object helper.
/** The subset of @react-pdf/renderer this package consumes. */
export interface ReactPdfPrimitives {
    readonly Document: string;
    readonly Page: string;
    readonly Text: string;
    readonly View: string;
    readonly StyleSheet: { create<T extends Record<string, unknown>>(styles: T): T };
    renderToBuffer(element: ReactElement): Promise<Buffer>;
}

let cached: Promise<ReactPdfPrimitives> | null = null;

export function loadReactPdf(): Promise<ReactPdfPrimitives> {
    if (!cached) {
        cached = dynamicImport('@react-pdf/renderer') as Promise<ReactPdfPrimitives>;
    }
    return cached;
}
