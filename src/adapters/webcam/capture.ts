/**
 * Visibility-independent capture pipeline (spec Part 3, "Capture pipeline").
 *
 * Reads frames straight off the camera's MediaStreamTrack via
 * MediaStreamTrackProcessor where supported — no <video> element at all.
 * Falls back to requestVideoFrameCallback on a <video> element that is
 * created but never appended to the document where MSTP is unsupported.
 * Neither path depends on anything being visible, or even present, on
 * screen: this is what lets the camera preview become a pure design choice
 * downstream (full-size, thumbnail, or hidden) instead of a tracking
 * requirement, and what avoids the POC's layout-pinning workaround for
 * browsers throttling off-screen <video> elements.
 *
 * Each captured VideoFrame is handed to the caller via onFrame and becomes
 * the caller's responsibility to close() — capture itself never buffers or
 * holds frames.
 */

export interface FrameCaptureHandle {
  /** Stops capture and releases the fallback video element, if one was created. */
  stop(): void;
}

export interface FrameCaptureCallbacks {
  onFrame: (frame: VideoFrame) => void;
  onError: (error: Error) => void;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** Starts capture on an already-acquired camera stream. */
export function startFrameCapture(stream: MediaStream, callbacks: FrameCaptureCallbacks): FrameCaptureHandle {
  const [track] = stream.getVideoTracks();
  if (!track) {
    throw new Error('MoveScape capture pipeline: the camera stream has no video track.');
  }

  if (typeof MediaStreamTrackProcessor !== 'undefined') {
    return startProcessorCapture(track, callbacks);
  }
  return startVideoFrameCallbackCapture(stream, callbacks);
}

/**
 * Primary path: read VideoFrames directly off the track via the Insertable
 * Streams API. Independent of any <video> element or DOM visibility by
 * construction.
 */
function startProcessorCapture(track: MediaStreamTrack, { onFrame, onError }: FrameCaptureCallbacks): FrameCaptureHandle {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let stopped = false;

  void (async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (stopped) {
          if (!result.done) result.value.close();
          break;
        }
        if (result.done) break;
        onFrame(result.value);
      }
    } catch (err) {
      if (!stopped) onError(toError(err));
    }
  })();

  return {
    stop() {
      stopped = true;
      reader.cancel().catch(() => {
        /* stream already closed/errored — nothing to do */
      });
    },
  };
}

/**
 * Fallback path: a detached (never appended) <video> element driven by
 * requestVideoFrameCallback, which — unlike a plain rAF-driven read loop —
 * keeps firing at the compositor's video frame rate regardless of page
 * visibility or whether the element is on screen at all.
 */
function startVideoFrameCallbackCapture(
  stream: MediaStream,
  { onFrame, onError }: FrameCaptureCallbacks
): FrameCaptureHandle {
  const video = document.createElement('video');
  if (typeof video.requestVideoFrameCallback !== 'function') {
    throw new Error(
      'MoveScape capture pipeline: neither MediaStreamTrackProcessor nor requestVideoFrameCallback is supported by this browser.'
    );
  }

  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Deliberately never appended to the document — capture must not depend
  // on any on-screen element.

  let stopped = false;
  let handle = 0;

  const onVideoFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    if (stopped) return;
    try {
      // mediaTime is in seconds; VideoFrame timestamps are microseconds.
      onFrame(new VideoFrame(video, { timestamp: metadata.mediaTime * 1_000_000 }));
    } catch (err) {
      onError(toError(err));
    }
    if (!stopped) {
      handle = video.requestVideoFrameCallback(onVideoFrame);
    }
  };

  video
    .play()
    .then(() => {
      if (!stopped) handle = video.requestVideoFrameCallback(onVideoFrame);
    })
    .catch((err: unknown) => onError(toError(err)));

  return {
    stop() {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
      video.pause();
      video.srcObject = null;
    },
  };
}
