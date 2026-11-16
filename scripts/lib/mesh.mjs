// ASCII STL and PLY files as KiCad writes them (mm, Z up): the bounding box of every vertex, and
// for STL the signed volume (negative or short where triangles face inwards).
import { readFileSync } from "node:fs";

const boxOf = (points) => {
  const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of points) for (let i = 0; i < 3; i++) (b.min[i] = Math.min(b.min[i], p[i])), (b.max[i] = Math.max(b.max[i], p[i]));
  return b;
};

export function stlBox(file) {
  const text = readFileSync(file, "utf8");
  const points = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  let volume = 0;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const [a, b, c] = [points[i], points[i + 1], points[i + 2]];
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return { box: boxOf(points), triangles: points.length / 3, volume };
}

export function plyBox(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const end = lines.indexOf("end_header");
  const head = lines.slice(0, end).join("\n");
  const vertices = Number(/element vertex (\d+)/.exec(head)[1]);
  const faces = Number(/element face (\d+)/.exec(head)[1]);
  const points = lines.slice(end + 1, end + 1 + vertices).map((l) => l.trim().split(/\s+/).slice(0, 3).map(Number));
  return { box: boxOf(points), vertices, faces, colors: /property uchar red/.test(head) };
}
