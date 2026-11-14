/**
 * A soft radial falloff, drawn once into a canvas instead of shipped as an
 * asset. Used for the hypothesis-node halo and the Pareto-frontier bloom:
 * additive *flat* colour reads as a hard bubble, additive falloff reads as
 * light, and light is what distinguishes a live hypothesis from a dead one and
 * a frontier candidate from a dominated one.
 *
 * Returns null during SSR, so every caller must treat it as optional.
 */

import * as THREE from "three";

export function makeGlowTexture(size = 128): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.45)");
  g.addColorStop(0.62, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
