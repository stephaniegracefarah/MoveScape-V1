/**
 * Downloads a canvas's current pixels as a PNG file, following the same
 * DI-for-testability pattern as `MinimalDocument` (src/adapters/sliders/)
 * and recipe-store.ts's injectable `idbFactory`: production code depends on
 * small hand-written structural interfaces instead of the real DOM types
 * directly, so tests can pass fakes without jsdom (this project's test
 * environment is plain Node -- see vite.config.ts).
 *
 * A real `HTMLCanvasElement`/`document`/`URL` all satisfy these interfaces
 * with zero casting: canvas.toBlob's real signature is
 * `(callback: BlobCallback, type?: string, quality?: any) => void` where
 * `BlobCallback = (blob: Blob | null) => void` -- `unknown` is a safe
 * narrowing for this module's own interface since it never inspects the
 * blob's contents, just passes it straight through to `createObjectURL`.
 */

export interface ExportableCanvas {
  toBlob(callback: (blob: unknown) => void, type?: string): void;
}

export interface ExportDocument {
  createElement(tagName: 'a'): ExportAnchor;
}

export interface ExportAnchor {
  href: string;
  download: string;
  click(): void;
}

export interface ExportUrlApi {
  createObjectURL(obj: unknown): string;
  revokeObjectURL(url: string): void;
}

/**
 * Triggers a browser download of `canvas`'s pixels as a PNG named
 * `filename`. If the blob callback receives `null` (a failed toBlob), does
 * nothing -- no throw. That's a browser-level edge case, not something the
 * caller can react to synchronously anyway, since toBlob is asynchronous.
 */
export function exportCanvasAsPng(
  canvas: ExportableCanvas,
  filename: string,
  doc: ExportDocument = document,
  urlApi: ExportUrlApi = URL,
): void {
  canvas.toBlob((blob) => {
    if (blob === null) return;

    const url = urlApi.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    urlApi.revokeObjectURL(url);
  }, 'image/png');
}
