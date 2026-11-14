"use client";

/**
 * `AdsorptionSites` — guest molecules sitting in a host framework, each
 * optionally labelled with its binding energy.
 *
 * Signature frozen by `components/three/CONTRACT.md`.
 *
 * The host is drawn by `StructureView`, dimmed and with no highlight, so the
 * guests read as the subject. Guests get full-brightness atoms, their own
 * intramolecular bonds, and a soft additive sphere marking the site — a bare
 * water molecule inside a MOF pore is otherwise almost impossible to pick out
 * from the framework atoms around it.
 *
 * Binding energies are shown as billboarded labels. More negative means more
 * strongly bound, so the label is tinted on a teal-to-amber ramp to make the
 * strong sites findable without reading every number.
 */

import { useMemo } from "react";
import { Billboard, Text } from "@react-three/drei";

import { TEXT_FONT_PROPS } from "./font";
import * as THREE from "three";

import { inferBonds } from "../../../lib/structure-parse";
import { boundingSphere } from "../../../lib/structure-parse";
import { AtomInstances } from "./AtomInstances";
import { BondInstances } from "./BondInstances";
import { StructureLights } from "./Lights";
import { StructureView } from "./StructureView";
import { normalizeGuests, normalizeStructure, type GuestData } from "./normalize";
import type { Frame, StructureData, Vec3 } from "./types";

export interface AdsorptionSitesProps {
  host: StructureData;
  guests: { symbols: string[]; positions: Frame; energy_ev?: number }[];
  /** Default true. */
  showHost?: boolean;

  // --- additive options (not in the frozen contract) -------------------
  lights?: boolean;
  /** Show the per-guest binding energy label. Default true. */
  showEnergyLabels?: boolean;
  /** Translucent marker sphere around each guest. Default true. */
  showSiteMarkers?: boolean;
  /** How far the host is faded back. 1 = no fading. */
  hostOpacity?: number;
}

export function AdsorptionSites(props: AdsorptionSitesProps) {
  const host = useMemo(() => normalizeStructure(props.host), [props.host]);
  const guests = useMemo(() => normalizeGuests(props.guests), [props.guests]);
  // A host with no guests is still worth drawing; no host at all is not.
  if (!host) return null;
  return <AdsorptionSitesInner {...props} host={host} guests={guests} />;
}

function AdsorptionSitesInner({
  host,
  guests,
  showHost = true,
  lights = true,
  showEnergyLabels = true,
  showSiteMarkers = true,
  hostOpacity = 0.55,
}: AdsorptionSitesProps & { host: StructureData; guests: GuestData[] }) {
  /** Per-guest bonds, inferred without periodic images (molecules are whole). */
  const guestGeometry = useMemo(
    () =>
      guests.map((g) => {
        const bonds = inferBonds(g.symbols, g.positions, null, false, {
          // Guests are small covalent molecules, so no cation exclusion here.
          exclude: [],
        });
        const sphere = boundingSphere(
          { symbols: g.symbols, cell: null, pbc: false, positions: g.positions },
          { includeCell: false, pad: 0.55 },
        );
        return { bonds, sphere };
      }),
    [guests],
  );

  /** Energy range, for the label colour ramp. */
  const energyRange = useMemo(() => {
    const vals = guests
      .map((g) => g.energy_ev)
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) return null;
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [guests]);

  const labelSize = useMemo(() => {
    const hostSphere = boundingSphere(host);
    return Math.max(0.35, hostSphere.radius * 0.055);
  }, [host]);

  return (
    <group>
      {lights && <StructureLights />}

      {showHost && (
        <StructureView
          data={host}
          lights={false}
          atomOpacity={hostOpacity}
          radiusScale={0.85}
          showAxes={false}
        />
      )}

      {guests.map((guest, gi) => {
        const { bonds, sphere } = guestGeometry[gi];
        const color = energyColor(guest.energy_ev, energyRange);
        const labelAt: Vec3 = [
          sphere.center[0],
          sphere.center[1] + sphere.radius + labelSize * 0.9,
          sphere.center[2],
        ];
        return (
          <group key={gi}>
            {showSiteMarkers && (
              <mesh position={sphere.center} renderOrder={4}>
                <sphereGeometry args={[sphere.radius, 24, 16]} />
                <meshBasicMaterial
                  color={color}
                  transparent
                  opacity={0.1}
                  blending={THREE.AdditiveBlending}
                  depthWrite={false}
                  side={THREE.BackSide}
                  toneMapped={false}
                />
              </mesh>
            )}

            <AtomInstances
              symbols={guest.symbols}
              positions={guest.positions}
              radiusScale={1.0}
              segments={[28, 20]}
            />

            {bonds.length > 0 && (
              <BondInstances
                symbols={guest.symbols}
                positions={guest.positions}
                bonds={bonds}
                cell={null}
                radius={0.1}
              />
            )}

            {showEnergyLabels && guest.energy_ev != null && (
              <Billboard position={labelAt}>
                <Text
          {...TEXT_FONT_PROPS}
                  fontSize={labelSize}
                  color={color}
                  anchorX="center"
                  anchorY="middle"
                  outlineWidth={labelSize * 0.1}
                  outlineColor="#05070a"
                >
                  {`${guest.energy_ev >= 0 ? "+" : "−"}${Math.abs(
                    guest.energy_ev,
                  ).toFixed(2)} eV`}
                </Text>
              </Billboard>
            )}
          </group>
        );
      })}
    </group>
  );
}

/**
 * Teal (most strongly bound, most negative) to amber (most weakly bound).
 * Falls back to a neutral slate when there is nothing to compare against.
 */
function energyColor(
  energy: number | undefined,
  range: { min: number; max: number } | null,
): string {
  if (energy == null || !range || range.max - range.min < 1e-9) return "#94a3b8";
  const t = (energy - range.min) / (range.max - range.min);
  const strong = new THREE.Color("#5eead4");
  const weak = new THREE.Color("#fbbf24");
  return `#${strong.clone().lerp(weak, t).getHexString()}`;
}
