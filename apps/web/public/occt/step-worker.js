/* Classic worker: converts STEP files to triangle meshes with OpenCascade (occt-import-js, LGPL-2.1).
 * In:  { id, buffer: ArrayBuffer }
 * Out: { id, meshes: [{ positions, normals, indices, colors }] } with transferable typed arrays. */
importScripts("occt-import-js.js");

const ready = occtimportjs({ locateFile: (p) => p });

onmessage = async (ev) => {
  const { id, buffer } = ev.data;
  try {
    const occt = await ready;
    const result = occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.5 });
    if (!result.success) throw new Error("STEP import failed");
    const meshes = [];
    const transfer = [];
    for (const m of result.meshes) {
      const positions = new Float32Array(m.attributes.position.array);
      const normals = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const indices = new Uint32Array(m.index.array);
      // Per-vertex colours from per-face colours (bodies are often black with silver pins).
      const base = m.color || [0.6, 0.6, 0.6];
      const colors = new Float32Array((positions.length / 3) * 3);
      for (let v = 0; v < colors.length; v += 3) colors.set(base, v);
      for (const f of m.brep_faces || []) {
        if (!f.color) continue;
        for (let t = f.first; t <= f.last; t++) {
          for (let k = 0; k < 3; k++) colors.set(f.color, indices[t * 3 + k] * 3);
        }
      }
      meshes.push({ positions, normals, indices, colors });
      transfer.push(positions.buffer, indices.buffer, colors.buffer);
      if (normals) transfer.push(normals.buffer);
    }
    postMessage({ id, meshes }, transfer);
  } catch (e) {
    postMessage({ id, error: String(e && e.message || e) });
  }
};
