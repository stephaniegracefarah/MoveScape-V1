/**
 * Ambient declaration for the Insertable Streams for MediaStreamTrack API
 * (`MediaStreamTrackProcessor`), used by capture.ts to read VideoFrames
 * directly off the camera track without any <video> element.
 *
 * It ships in TypeScript's "webworker" lib but not "dom", and this
 * project's tsconfig intentionally sticks to "dom" project-wide (mixing
 * "dom" and "webworker" libs conflicts on shared globals like `self`).
 * Declared locally, scoped to this directory, so the capture pipeline can
 * feature-detect and use the real browser API without widening the
 * project's global lib configuration.
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}

interface MediaStreamTrackProcessor {
  readonly readable: ReadableStream<VideoFrame>;
}

declare const MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new (init: MediaStreamTrackProcessorInit): MediaStreamTrackProcessor;
};
