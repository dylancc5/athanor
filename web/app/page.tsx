"use client";

// Toolchain smoke page: proves react-three-fiber renders and that the
// generated event union narrows. Replaced by the real campaign UI.

import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { Body, Event } from "@/lib/contracts";

function describe(body: Body): string {
  switch (body.type) {
    case "campaign.started":
      return `goal: ${body.goal}`;
    case "measurement.recorded":
      return `${body.measurement.property} = ${body.measurement.value} ${body.measurement.unit}`;
    case "analyst.verdict":
      return `${body.hypothesis_id}: ${body.verdict}`;
    default:
      return body.type;
  }
}

const sample: Event[] = [
  {
    seq: 0,
    t: 0,
    campaign_id: "smoke",
    body: { type: "campaign.started", goal: "toolchain check" },
  },
];

export default function Home() {
  return (
    <main className="h-dvh w-full bg-neutral-950 text-neutral-100">
      <div className="p-6 font-mono text-sm">
        {sample.map((e) => (
          <div key={e.seq}>{describe(e.body)}</div>
        ))}
      </div>
      <div className="h-[60vh] w-full">
        <Canvas camera={{ position: [3, 3, 3] }}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 5, 5]} />
          <mesh>
            <icosahedronGeometry args={[1, 1]} />
            <meshStandardMaterial color="#7dd3fc" flatShading />
          </mesh>
          <OrbitControls />
        </Canvas>
      </div>
    </main>
  );
}
