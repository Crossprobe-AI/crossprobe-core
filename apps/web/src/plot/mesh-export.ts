/**
 * The board as STL or PLY, as KiCad's `pcb export stl` / `pcb export ply` write them: the same
 * board body and placed part models as the GLB export, in millimetres with Z up (KiCad's board Y
 * negated). STL is one ASCII solid with a normal per facet and no colour. PLY is ASCII with a normal
 * and an sRGB colour per vertex, and a surface id per face (here one per mesh).
 */
import * as THREE from "three";
import type { Board } from "@crossprobe/kicad-model";
import type { ModelLibrary } from "../three/models";
import { exportScene } from "./glb-export";

type Tri = { a: number; b: number; c: number; material: number };

/** Each mesh in the scene, in world space: positions, normals, its triangles and their materials. */
function* worldMeshes(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.visible) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute("position");
    if (!pos) continue;
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const nrm = g.getAttribute("normal");
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const points: number[] = [];
    const normals: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      n.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
      points.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
    }
    const index = g.getIndex();
    const count = index ? index.count : pos.count;
    const at = (k: number) => (index ? index.getX(k) : k);
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    const tris: Tri[] = [];
    for (const gr of groups)
      for (let k = gr.start; k + 2 < Math.min(gr.start + gr.count, count); k += 3) tris.push({ a: at(k), b: at(k + 1), c: at(k + 2), material: gr.materialIndex ?? 0 });
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // A mirrored placement (a part on the back) turns the triangles inside out; flip them back.
    const flip = mesh.matrixWorld.determinant() < 0;
    yield { points, normals, tris: flip ? tris.map((t) => ({ ...t, b: t.c, c: t.b })) : tris, materials, colors: g.getAttribute("color") };
  }
}

const e = (v: number) => v.toExponential(6);

export async function exportStl(board: Board, name: string, library?: ModelLibrary) {
  const { root, placed, skipped } = await exportScene(board, name, library);
  const out: string[] = ["solid \n"];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const m of worldMeshes(root)) {
    const v = (i: number, t: THREE.Vector3) => t.set(m.points[i * 3]!, m.points[i * 3 + 1]!, m.points[i * 3 + 2]!);
    for (const t of m.tris) {
      v(t.a, a), v(t.b, b), v(t.c, c);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (n.lengthSq() === 0) continue;
      n.normalize();
      out.push(` facet normal ${e(n.x)} ${e(n.y)} ${e(n.z)}\n   outer loop\n`);
      for (const p of [a, b, c]) out.push(`     vertex  ${e(p.x)} ${e(p.y)} ${e(p.z)}\n`);
      out.push("   endloop\n endfacet\n");
    }
  }
  out.push("endsolid\n");
  return { blob: new Blob(out, { type: "model/stl" }), placed, skipped };
}

export async function exportPly(board: Board, name: string, library?: ModelLibrary) {
  const { root, placed, skipped } = await exportScene(board, name, library);
  const vertices: string[] = [];
  const faces: string[] = [];
  const srgb = { r: 0, g: 0, b: 0 };
  const byte = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  let base = 0;
  let surface = 0;
  const g6 = (x: number) => String(Number(x.toPrecision(6)));
  for (const m of worldMeshes(root)) {
    // A vertex takes the colour of the material of the first triangle that uses it.
    const material = new Array<number>(m.points.length / 3).fill(-1);
    for (const t of m.tris) for (const i of [t.a, t.b, t.c]) if (material[i] === -1) material[i] = t.material;
    for (let i = 0; i < material.length; i++) {
      if (m.colors) {
        const col = new THREE.Color(m.colors.getX(i), m.colors.getY(i), m.colors.getZ(i));
        col.getRGB(srgb, THREE.SRGBColorSpace);
      } else {
        const mat = m.materials[Math.max(0, material[i]!)] as THREE.MeshStandardMaterial | undefined;
        (mat?.color ?? new THREE.Color(0.8, 0.8, 0.8)).getRGB(srgb, THREE.SRGBColorSpace);
      }
      const k = i * 3;
      vertices.push(`${g6(m.points[k]!)} ${g6(m.points[k + 1]!)} ${g6(m.points[k + 2]!)} ${g6(m.normals[k]!)} ${g6(m.normals[k + 1]!)} ${g6(m.normals[k + 2]!)} ${byte(srgb.r)} ${byte(srgb.g)} ${byte(srgb.b)}\n`);
    }
    for (const t of m.tris) faces.push(`3 ${base + t.a} ${base + t.b} ${base + t.c} ${surface}\n`);
    base += material.length;
    surface++;
  }
  const header = [
    "ply",
    "format ascii 1.0",
    "comment Exported by Crossprobe",
    `comment pcb_name: ${name}`,
    `comment generated_at: ${new Date().toISOString().slice(0, 19)}`,
    `element vertex ${vertices.length}`,
    ...["x", "y", "z", "nx", "ny", "nz"].map((p) => `property float ${p}`),
    ...["red", "green", "blue"].map((p) => `property uchar ${p}`),
    `element face ${faces.length}`,
    "property list uchar uint vertex_indices",
    "property uint SurfaceID",
    "end_header\n",
  ].join("\n");
  return { blob: new Blob([header, ...vertices, ...faces], { type: "application/octet-stream" }), placed, skipped };
}
