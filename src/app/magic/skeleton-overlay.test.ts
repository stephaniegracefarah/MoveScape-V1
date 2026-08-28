import { describe, expect, it } from 'vitest';
import type { PosePoint } from '../../adapters/input-adapter';
import {
  POSE_CONNECTIONS,
  drawSkeleton,
  skeletonSegments,
  type SkeletonCtx,
} from './skeleton-overlay';

/** A relaxed full 33-landmark pose, every point at the image centre. */
function fullPose(): PosePoint[] {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}

/** Records every call so a test can assert what was (and wasn't) drawn. */
function stubCtx(): SkeletonCtx & {
  calls: { clearRect: number; moveTo: number; lineTo: number; stroke: number; beginPath: number };
} {
  const calls = { clearRect: 0, moveTo: 0, lineTo: 0, stroke: 0, beginPath: 0 };
  return {
    calls,
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    globalAlpha: 1,
    clearRect: () => {
      calls.clearRect++;
    },
    beginPath: () => {
      calls.beginPath++;
    },
    moveTo: () => {
      calls.moveTo++;
    },
    lineTo: () => {
      calls.lineTo++;
    },
    stroke: () => {
      calls.stroke++;
    },
  };
}

describe('skeletonSegments', () => {
  it('returns one segment per connection for a full pose, scaled into the box', () => {
    const segments = skeletonSegments(fullPose(), 200, 100);
    expect(segments).toHaveLength(POSE_CONNECTIONS.length);
    for (const s of segments) {
      expect(s).toEqual({ ax: 100, ay: 50, bx: 100, by: 50 });
    }
  });

  it('returns [] for a null pose', () => {
    expect(skeletonSegments(null, 200, 100)).toEqual([]);
  });

  it('returns [] for a partial pose (fewer than 33 landmarks)', () => {
    const partial = Array.from({ length: 10 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    expect(skeletonSegments(partial, 200, 100)).toEqual([]);
  });
});

describe('drawSkeleton', () => {
  it('draws two vertices per connection plus one stroke when active with a full pose', () => {
    const ctx = stubCtx();
    drawSkeleton(ctx, fullPose(), { active: true, width: 200, height: 100 });
    expect(ctx.calls.clearRect).toBe(1);
    expect(ctx.calls.moveTo).toBe(POSE_CONNECTIONS.length);
    expect(ctx.calls.lineTo).toBe(POSE_CONNECTIONS.length);
    expect(ctx.calls.stroke).toBe(1);
    expect(ctx.strokeStyle).toBe('#241a17');
    expect(ctx.globalAlpha).toBe(1); // reset after stroking
  });

  it('only clears (no stroke) when inactive', () => {
    const ctx = stubCtx();
    drawSkeleton(ctx, fullPose(), { active: false, width: 200, height: 100 });
    expect(ctx.calls.clearRect).toBe(1);
    expect(ctx.calls.moveTo).toBe(0);
    expect(ctx.calls.lineTo).toBe(0);
    expect(ctx.calls.stroke).toBe(0);
  });

  it('only clears (no stroke) when active but the pose is null', () => {
    const ctx = stubCtx();
    drawSkeleton(ctx, null, { active: true, width: 200, height: 100 });
    expect(ctx.calls.clearRect).toBe(1);
    expect(ctx.calls.stroke).toBe(0);
  });
});
