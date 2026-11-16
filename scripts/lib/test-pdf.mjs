// A minimal one-page PDF with lines of text (Helvetica), for scripted datasheet runs.
import { writeFileSync } from "node:fs";

export function writeTextPdf(path, lines, { title = "Test datasheet" } = {}) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = ["BT", "/F1 11 Tf", "14 TL", "60 760 Td", ...lines.flatMap((l, i) => [i ? "T*" : "", `(${esc(l)}) Tj`]).filter(Boolean), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${esc(title)}) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path, out);
}
