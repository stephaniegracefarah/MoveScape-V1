/**
 * A minimal placeholder StyleRenderer whose only purpose is to exercise the
 * engine and compositor (spec Part 3) -- not meant to be aesthetically
 * interesting.
 */
import type { MovementParams } from '../../adapters/movement-params';
import type { SessionParams } from '../../engine/session-params';
import { clamp01 } from '../../shared/math';
import { createLabeledStream } from '../../world/labeled-stream';
import type { World } from '../../world/world';
import type { Scene, SceneElement, StyleRenderer } from '../style-renderer';

// World-knob ranges: circleCountRaw/driftSpeedRaw are [0,1) draws from the
// labeled stream, mapped here into ranges usable by the style itself.
const MIN_CIRCLE_COUNT = 3;
const CIRCLE_COUNT_SPAN = 6; // circleCount lands in [3, 8]
const MIN_DRIFT_SPEED = 0.5;
const DRIFT_SPEED_SPAN = 1.5; // driftSpeed lands in [0.5, 2)

// Per-circle spawn ranges, drawn once at init() from the session stream.
const MIN_RADIUS = 0.02;
const RADIUS_SPAN = 0.08;

const DRIFT_AMPLITUDE = 0.1;
const BASE_OPACITY = 0.8;

/** Fixed at init() from the session's labeled stream; step() only reads it. */
interface CircleSpawn {
  initialX: number;
  initialY: number;
  z: number;
  radius: number;
  color: string;
  phase: number;
}

export function createDriftingCirclesStyle(): StyleRenderer {
  let circles: CircleSpawn[] = [];
  let driftSpeed = MIN_DRIFT_SPEED;
  let elements: SceneElement[] = [];

  return {
    id: 'placeholder-drifting-circles',
    name: 'Drifting Circles (placeholder)',
    aestheticFamily: 'organic',

    worldKnobs(): string[] {
      return ['placeholderCircleCount', 'placeholderDriftSpeed'];
    },

    init(world: World): void {
      const circleCountRaw = world.knob('placeholderCircleCount');
      const driftSpeedRaw = world.knob('placeholderDriftSpeed');
      const circleCount = MIN_CIRCLE_COUNT + Math.floor(circleCountRaw * CIRCLE_COUNT_SPAN);
      driftSpeed = MIN_DRIFT_SPEED + driftSpeedRaw * DRIFT_SPEED_SPAN;

      // Session-level, not world-level: initial spawn placement and jitter
      // are per-performance details (spec Part 3's own framing of what
      // sessionSeed governs), so this stream is keyed off world.sessionSeed
      // rather than world.worldSeed. All randomness in this style happens
      // right here, at init() -- step() never draws from it.
      const draw = createLabeledStream(world.sessionSeed, 'placeholder-circles');
      const spawned: CircleSpawn[] = [];
      for (let i = 0; i < circleCount; i++) {
        spawned.push({
          initialX: draw(),
          initialY: draw(),
          z: draw(),
          radius: MIN_RADIUS + draw() * RADIUS_SPAN,
          color: `hsl(${Math.floor(draw() * 360)} 70% 55%)`,
          phase: draw() * Math.PI * 2,
        });
      }
      circles = spawned;
      elements = [];
    },

    // Invariant 4: a pure function of stored circle state plus (params,
    // time) -- no Math.random, no Date.now/performance.now, so identical
    // call sequences always reproduce the identical scene.
    step(params: MovementParams, _sessionParams: SessionParams, time: number): void {
      const expansionInfluence = 0.3 + params.expansion;
      const opacity = clamp01(BASE_OPACITY * (0.6 + params.speed * 0.4));

      elements = circles.map((circle) => {
        const cycle = time * 0.001 * driftSpeed + circle.phase;
        const x = clamp01(circle.initialX + Math.sin(cycle) * DRIFT_AMPLITUDE * expansionInfluence);
        const y = clamp01(circle.initialY + Math.cos(cycle) * DRIFT_AMPLITUDE * expansionInfluence);
        return {
          kind: 'circle',
          z: circle.z,
          x,
          y,
          radius: circle.radius,
          color: circle.color,
          opacity,
        };
      });
    },

    scene(): Scene {
      return { elements: [...elements] };
    },

    finish(): Scene {
      return { elements: [...elements] };
    },
  };
}
