"use client";

/**
 * The lighting rig every structure view ships with.
 *
 * No agent owns the `<Canvas>`'s lights, and a `MeshStandardMaterial` renders
 * black with no lights at all — so each top-level component mounts this by
 * default and exposes `lights={false}` for the case where the shell (or an
 * enclosing structure view) already provides them.
 *
 * Three-point setup tuned for atoms: a key light slightly above and to the
 * right for a crisp specular terminator, a cool fill from the opposite side so
 * shadowed hemispheres stay readable rather than going to black, and a dim rim
 * light from behind to separate silhouettes from a dark background. The
 * hemisphere light supplies a sky/ground gradient that reads as ambient
 * occlusion without the cost of actual AO.
 *
 * Lights are parented to the camera-independent world, and intensities assume
 * R3F's default ACES tone mapping.
 */
export function StructureLights({ intensity = 1 }: { intensity?: number }) {
  return (
    <group>
      <hemisphereLight args={["#b9c7d9", "#20242c", 0.55 * intensity]} />
      <ambientLight intensity={0.18 * intensity} />
      <directionalLight
        position={[40, 55, 35]}
        intensity={1.5 * intensity}
        color="#fffaf2"
      />
      <directionalLight
        position={[-35, 18, -28]}
        intensity={0.5 * intensity}
        color="#8fb4ff"
      />
      <directionalLight
        position={[6, -30, -40]}
        intensity={0.35 * intensity}
        color="#cfe3ff"
      />
    </group>
  );
}
