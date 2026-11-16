// A GLB's geometry by component: every vertex in world space (glTF metres, Y up), boxed per
// top-level part (the nearest ancestor node whose name is in `names`) and overall, in mm.
import { readFileSync } from "node:fs";

const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const trs = (n) => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};

export function glbBoxes(file, names) {
  const b = readFileSync(file);
  const jlen = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jlen).toString("utf8"));
  const bin = b.subarray(20 + jlen + 8);
  const boxes = new Map();
  const grow = (key, p) => {
    let bx = boxes.get(key);
    if (!bx) boxes.set(key, (bx = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    for (let i = 0; i < 3; i++) (bx.min[i] = Math.min(bx.min[i], p[i] * 1000)), (bx.max[i] = Math.max(bx.max[i], p[i] * 1000));
  };
  let meshes = 0;
  const walk = (i, m, part) => {
    const n = j.nodes[i];
    const w = mul(m, trs(n));
    const p = part ?? (names.has(n.name) ? n.name : undefined);
    if (n.mesh !== undefined) {
      meshes++;
      for (const prim of j.meshes[n.mesh].primitives) {
        const a = j.accessors[prim.attributes.POSITION];
        const v = j.bufferViews[a.bufferView];
        const stride = v.byteStride ?? 12;
        for (let k = 0; k < a.count; k++) {
          const o = (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + k * stride;
          const x = bin.readFloatLE(o), y = bin.readFloatLE(o + 4), z = bin.readFloatLE(o + 8);
          const q = [w[0] * x + w[4] * y + w[8] * z + w[12], w[1] * x + w[5] * y + w[9] * z + w[13], w[2] * x + w[6] * y + w[10] * z + w[14]];
          grow("*", q);
          if (p) grow(p, q);
        }
      }
    }
    for (const c of n.children ?? []) walk(c, w, p);
  };
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of j.scenes[j.scene ?? 0].nodes) walk(r, id, undefined);
  return { boxes, meshes };
}
