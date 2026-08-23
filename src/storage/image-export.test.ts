import { describe, expect, it } from 'vitest';
import {
  exportCanvasAsPng,
  type ExportAnchor,
  type ExportableCanvas,
  type ExportDocument,
  type ExportUrlApi,
} from './image-export';

/**
 * Minimal in-memory stand-ins for the DOM/URL APIs, just enough to exercise
 * exportCanvasAsPng's logic without a real browser or jsdom (this project's
 * test environment is plain Node -- see vite.config.ts). Mirrors the
 * fake-element style used in src/adapters/sliders/index.test.ts.
 */
function createFakeAnchor(): ExportAnchor & { clicked: boolean } {
  return {
    href: '',
    download: '',
    clicked: false,
    click() {
      this.clicked = true;
    },
  };
}

function createFakeCanvas(blobToDeliver: unknown): ExportableCanvas & { calls: { type?: string }[] } {
  const calls: { type?: string }[] = [];
  return {
    calls,
    toBlob(callback: (blob: unknown) => void, type?: string) {
      calls.push({ type });
      callback(blobToDeliver);
    },
  };
}

function createFakeDocument(): { doc: ExportDocument; anchors: (ExportAnchor & { clicked: boolean })[] } {
  const anchors: (ExportAnchor & { clicked: boolean })[] = [];
  const doc: ExportDocument = {
    createElement: (tagName: 'a') => {
      expect(tagName).toBe('a');
      const anchor = createFakeAnchor();
      anchors.push(anchor);
      return anchor;
    },
  };
  return { doc, anchors };
}

function createFakeUrlApi(urlToReturn: string): ExportUrlApi & { revoked: string[]; created: unknown[] } {
  const revoked: string[] = [];
  const created: unknown[] = [];
  return {
    revoked,
    created,
    createObjectURL(obj: unknown) {
      created.push(obj);
      return urlToReturn;
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
  };
}

describe('exportCanvasAsPng', () => {
  it('calls toBlob with the "image/png" type', () => {
    const fakeBlob = { fake: 'blob' };
    const canvas = createFakeCanvas(fakeBlob);
    const { doc } = createFakeDocument();
    const urlApi = createFakeUrlApi('blob:fake-url');

    exportCanvasAsPng(canvas, 'piece.png', doc, urlApi);

    expect(canvas.calls).toHaveLength(1);
    expect(canvas.calls[0]?.type).toBe('image/png');
  });

  it('when the blob callback fires with a blob, creates an anchor with the right download filename and href, and clicks it', () => {
    const fakeBlob = { fake: 'blob' };
    const canvas = createFakeCanvas(fakeBlob);
    const { doc, anchors } = createFakeDocument();
    const urlApi = createFakeUrlApi('blob:fake-url');

    exportCanvasAsPng(canvas, 'my-piece.png', doc, urlApi);

    expect(urlApi.created).toEqual([fakeBlob]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.download).toBe('my-piece.png');
    expect(anchors[0]?.href).toBe('blob:fake-url');
    expect(anchors[0]?.clicked).toBe(true);
  });

  it('revokes the same object URL after clicking', () => {
    const canvas = createFakeCanvas({ fake: 'blob' });
    const { doc } = createFakeDocument();
    const urlApi = createFakeUrlApi('blob:fake-url');

    exportCanvasAsPng(canvas, 'piece.png', doc, urlApi);

    expect(urlApi.revoked).toEqual(['blob:fake-url']);
  });

  it('when the blob callback fires with null, creates no anchor and does not throw', () => {
    const canvas = createFakeCanvas(null);
    const { doc, anchors } = createFakeDocument();
    const urlApi = createFakeUrlApi('blob:fake-url');

    expect(() => exportCanvasAsPng(canvas, 'piece.png', doc, urlApi)).not.toThrow();

    expect(anchors).toHaveLength(0);
    expect(urlApi.created).toHaveLength(0);
    expect(urlApi.revoked).toHaveLength(0);
  });
});
