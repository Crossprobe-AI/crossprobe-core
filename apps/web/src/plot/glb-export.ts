/**
 * The board as a GLB (binary glTF), as KiCad's GLB export makes it: the board body (KiCad's body
 * solid: dielectrics and inner copper, with the pad holes) and every footprint's 3D model, VRML ones
 * included (KiCad meshes those for its mesh formats, unlike for STEP), placed as for STEP: on the
 * outer copper plus KiCad's 0.05 mm board offset, with the model's own offset, rotation and scale.
 * glTF is in metres with Y up; KiCad's board X stays X and its Y goes into the screen (+Z).
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { boardBodySolid, boardBodyThickness, type Board, type StepSolid } from "@crossprobe/kicad-model";
import { modelMatrix } from "../three/board3d";
import type { ModelLibrary } from "../three/models";

/** A planar-faced solid as a triangle mesh (each face triangulated in its own plane). */
function solidMesh(s: StepSolid): THREE.Mesh {
  const pos: number[] = [];
  for (const raw of s.faces) {
    // A loop that repeats its first point at the end would lose it in three's triangulation, and
    // with it the indices of every later loop.
    const loops = raw.map((l) => (l.length > 1 && l[0]!.every((x, i) => x === l[l.length - 1]![i]) ? l.slice(0, -1) : l));
    const outer = loops[0]!;
    // Newell's normal picks the plane to flatten the face onto.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i]!, b = outer[(i + 1) % outer.length]!;
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
    const flat = (loop: typeof outer) => loop.map((p) => new THREE.Vector2(p[u], p[v]));
    const all = loops.flat();
    // The triangulation winds every triangle one way in its 2D plane; turn each to face the way the
    // face does (outward), or faces on the far side of their plane come out inside out.
    for (const t of THREE.ShapeUtils.triangulateShape(flat(outer), loops.slice(1).map(flat))) {
      const [a, b, c] = t.map((i) => all[i]!) as [(typeof outer)[number], (typeof outer)[number], (typeof outer)[number]];
      const d1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const, d2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
      const dot = (d1[1] * d2[2] - d1[2] * d2[1]) * nx + (d1[2] * d2[0] - d1[0] * d2[2]) * ny + (d1[0] * d2[1] - d1[1] * d2[0]) * nz;
      for (const p of dot < 0 ? [a, c, b] : [a, b, c]) pos.push(...p);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const color = new THREE.Color().setRGB(s.color[0], s.color[1], s.color[2], THREE.SRGBColorSpace);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide }));
  mesh.name = s.name;
  return mesh;
}

export type ExportScene = { root: THREE.Group; placed: number; skipped: Array<{ reference: string; path: string }> };

/** The board body and every part model, in KiCad's export frame: mm, Z up, the board's Y negated. */
export async function exportScene(board: Board, name: string, library?: ModelLibrary): Promise<ExportScene> {
  const root = new THREE.Group();
  root.name = name;
  const body = boardBodySolid(board);
  if (body) root.add(solidMesh({ ...body, name: `${name}_PCB` }));
  // As KiCad's STEP and mesh exports: models on the outer copper, 0.05 mm proud of it, where KiCad's exports place them.
  const cu = (l: string) => board.copperThickness?.[l] ?? 0.035;
  const seat = { top: boardBodyThickness(board) + cu("F.Cu") + 0.05, bottom: -(cu("B.Cu") + 0.05) };
  let placed = 0;
  const skipped: Array<{ reference: string; path: string }> = [];
  const jobs = board.footprints.flatMap((fp) => fp.models.filter((m) => !m.hidden && m.path).map((m) => ({ fp, m })));
  const loaded = await Promise.all(jobs.map(async (j) => ({ ...j, t: library ? await library.load(j.m.path) : undefined })));
  for (const { fp, m, t } of loaded) {
    if (!t) {
      skipped.push({ reference: fp.reference, path: m.path });
      continue;
    }
    const inst = t.clone();
    inst.applyMatrix4(modelMatrix(fp, m, seat));
    inst.name = fp.reference;
    root.add(inst);
    placed++;
  }
  root.updateMatrixWorld(true);
  return { root, placed, skipped };
}

export async function exportGlb(board: Board, name: string, library?: ModelLibrary): Promise<{ bytes: Uint8Array; placed: number; skipped: Array<{ reference: string; path: string }> }> {
  const { root, placed, skipped } = await exportScene(board, name, library);
  // KiCad's millimetres, Z up → glTF's metres, Y up.
  const gltf = new THREE.Group();
  gltf.name = name;
  gltf.rotation.x = -Math.PI / 2;
  gltf.scale.setScalar(0.001);
  for (const c of [...root.children]) gltf.add(c);
  const scene = new THREE.Scene();
  scene.add(gltf);
  const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  return { bytes: new Uint8Array(glb), placed, skipped };
}
