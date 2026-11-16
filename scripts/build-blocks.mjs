#!/usr/bin/env node
/**
 * Build the design-block library from its specs:
 *
 *   npm run build   # uses the built @crossprobe/kicad-model
 *   node scripts/build-blocks.mjs [--symbols DIR] [--out DIR] [--check] [--web DIR]
 *   node scripts/build-blocks.mjs --web-only DIR   # just export what is committed (no KiCad needed)
 *
 * A spec with a `layout` also gets a .kicad_pcb (footprints, tracks, vias), checked with
 * KiCad's DRC and schematic-parity test, and a layout image (<id>-pcb.svg and .png).
 *
 * Also renders each block's schematic as blocks/images/<id>.svg (cropped, for the
 * block's page) and <id>.png (1200 x 630, for social previews) with kicad-cli and
 * rsvg-convert, when they are installed. Skip with --no-images.
 *
 * Reads blocks/specs/*.json, generates each block's schematic with KiCad's own
 * symbols, verifies it against its spec (nets, citations), and writes
 *   <out>/crossprobe.kicad_blocks/<id>.kicad_block/{<id>.kicad_sch, <id>.json, <id>.crossprobe.json}
 * in KiCad's design-block format. The output is committed, so a review is a
 * normal diff (the output is deterministic, UUIDs included). With --check
 * nothing is written; it fails if the committed library differs from what the
 * specs generate. With --web DIR the committed library is also written as the
 * flat files the app fetches at /__blocks/ (index.json, <id>.kicad_sch,
 * <id>.crossprobe.json), as a site that lists the blocks serves them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { blockManifest, checkSpecCitations, generateBlockBoard, generateBlockSchematic, kicadBlockJson, verifyBlock } from "../packages/kicad-model/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: opts } = parseArgs({ options: { symbols: { type: "string" }, out: { type: "string" }, check: { type: "boolean" }, web: { type: "string" }, "web-only": { type: "string" }, "no-images": { type: "boolean" } } });
const outDir = resolve(opts.out ?? join(root, "blocks/library"));
const LIB = "crossprobe.kicad_blocks";

/** Flat files for hosting, from what is committed (not regenerated): what is served is what was reviewed. */
function writeWeb(webDir) {
  const libDir = join(outDir, LIB);
  const ids = readdirSync(libDir).filter((d) => d.endsWith(".kicad_block")).map((d) => d.replace(/\.kicad_block$/, "")).sort();
  mkdirSync(webDir, { recursive: true });
  const index = [];
  for (const id of ids) {
    const dir = join(libDir, `${id}.kicad_block`);
    const m = JSON.parse(readFileSync(join(dir, `${id}.crossprobe.json`), "utf8"));
    writeFileSync(join(webDir, `${id}.kicad_sch`), readFileSync(join(dir, `${id}.kicad_sch`)));
    if (existsSync(join(dir, `${id}.kicad_pcb`))) writeFileSync(join(webDir, `${id}.kicad_pcb`), readFileSync(join(dir, `${id}.kicad_pcb`)));
    writeFileSync(join(webDir, `${id}.crossprobe.json`), JSON.stringify(m));
    index.push({ id, title: m.title, description: m.description, category: m.category, status: m.status, keywords: m.keywords, license: m.license, reviewedBy: m.reviewedBy, reviewedAt: m.reviewedAt, parts: m.parts.length, checklist: m.checklist.length });
  }
  writeFileSync(join(webDir, "index.json"), JSON.stringify(index));
  console.log(`web: ${ids.length} block(s) written to ${webDir}`);
}

if (opts["web-only"]) {
  writeWeb(opts["web-only"]);
  process.exit(0);
}

const symbolsDir =
  opts.symbols ?? process.env.KICAD_SYMBOLS ?? ["/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols", "/usr/share/kicad/symbols"].find((d) => existsSync(d));
if (!symbolsDir) throw new Error("KiCad's symbol libraries not found: pass --symbols DIR or set KICAD_SYMBOLS");
const footprintsDir =
  process.env.KICAD_FOOTPRINTS ?? ["/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints", "/usr/share/kicad/footprints"].find((d) => existsSync(d));
const footprints = (libId) => {
  const [lib, name] = libId.split(":");
  return readFileSync(join(footprintsDir, `${lib}.pretty`, `${name}.kicad_mod`), "utf8");
};

const cache = new Map();
const symbols = (lib) => {
  if (!cache.has(lib)) cache.set(lib, readFileSync(join(symbolsDir, `${lib}.kicad_sym`), "utf8"));
  return cache.get(lib);
};


// ---------- images ----------

const KICAD_CLI = process.env.KICAD_CLI ?? ["/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli", "kicad-cli"].find((c) => c === "kicad-cli" || existsSync(c));

const have = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** A KiCad SVG cropped to its drawing: viewBox from the coordinates, no timestamp, 3 decimals. */
function cropSvg(svg, title, description, margin = 4) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y, r = 0) => {
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
  };
  // Path data is M/L (x y pairs) and A (rx ry rotation large-arc sweep x y): only the end points matter.
  for (const m of svg.matchAll(/\bd="([^"]*)"/g)) {
    for (const seg of m[1].matchAll(/([MLA])([^MLA]*)/g)) {
      const n = (seg[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (seg[1] === "A") for (let i = 0; i + 6 < n.length; i += 7) grow(n[i + 5], n[i + 6]);
      else for (let i = 0; i + 1 < n.length; i += 2) grow(n[i], n[i + 1]);
    }
  }
  for (const m of svg.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g)) grow(+m[1], +m[2], +m[3]);
  for (const m of svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)) {
    if (+m[3] > 290) continue; // the page background
    grow(+m[1], +m[2]);
    grow(+m[1] + +m[3], +m[2] + +m[4]);
  }
  const x = Math.floor(minX - margin), y = Math.floor(minY - margin);
  const w = Math.ceil(maxX + margin) - x, h = Math.ceil(maxY + margin) - y;
  return {
    width: w,
    height: h,
    x,
    y,
    svg: svg
      .replace(/<!DOCTYPE[^>]*>\s*/, "")
      .replace(/ xmlns:svg="[^"]*"| xmlns:inkscape="[^"]*"/g, "")
      .replace(/width="[^"]*mm" height="[^"]*mm" viewBox="[^"]*"/, `width="${w}mm" height="${h}mm" viewBox="${x} ${y} ${w} ${h}"`)
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(/<desc>Image generated by Eeschema-SVG <\/desc>/, `<desc>${description}</desc>`)
      .replace(/<rect x="0\.0+" y="0\.0+" width="29[^"]*" height="[^"]*"/, `<rect x="${x}" y="${y}" width="${w}" height="${h}"`)
      .replace(/#F5F4EF/gi, "#ffffff") // white, not KiCad's page beige: sits cleanly on the site
      .replace(/(\d+\.\d{3})\d+/g, "$1"),
  };
}

function writeImages(spec, schPath) {
  if (opts["no-images"] || !KICAD_CLI || !have(KICAD_CLI, ["version"])) {
    if (!opts["no-images"]) console.warn("  (no images: kicad-cli not found)");
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), "crossprobe-blockimg-"));
  const copy = join(tmp, "block.kicad_sch");
  writeFileSync(copy, readFileSync(schPath));
  execFileSync(KICAD_CLI, ["sch", "export", "svg", "--exclude-drawing-sheet", "-o", tmp, copy], { stdio: "ignore" });
  const crop = cropSvg(readFileSync(join(tmp, "block.svg"), "utf8"), `${spec.title}: schematic`, `Schematic of ${spec.title}`);
  const dir = join(root, "blocks/images");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${spec.id}.svg`), crop.svg);
  let png = "";
  if (have("rsvg-convert", ["--version"])) {
    // Social preview: the schematic centred on a 1200 x 630 canvas on white.
    const inner = crop.svg.slice(crop.svg.indexOf(">", crop.svg.indexOf("<svg")) + 1, crop.svg.lastIndexOf("</svg>"));
    const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#ffffff"/><svg x="30" y="20" width="1140" height="590" viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}" preserveAspectRatio="xMidYMid meet">${inner}</svg></svg>`;
    writeFileSync(join(tmp, "og.svg"), wrapper);
    execFileSync("rsvg-convert", ["-w", "1200", "-h", "630", join(tmp, "og.svg"), "-o", join(dir, `${spec.id}.png`)]);
    png = " + png";
  } else console.warn("  (no png: rsvg-convert not found)");
  console.log(`  image: blocks/images/${spec.id}.svg (${Math.round(crop.svg.length / 1024)} KB, ${crop.width} x ${crop.height} mm)${png}`);
}

// ---------- PCB layout: DRC and image ----------

/** KiCad's DRC with schematic parity on a block's board. A block has no outline, so that one finding is expected; anything else fails. */
function drcProblems(spec, sch, pcb) {
  if (!KICAD_CLI || !have(KICAD_CLI, ["version"])) return [];
  const tmp = mkdtempSync(join(tmpdir(), "crossprobe-blockdrc-"));
  writeFileSync(join(tmp, "block.kicad_pro"), "{}\n");
  writeFileSync(join(tmp, "block.kicad_sch"), sch);
  writeFileSync(join(tmp, "block.kicad_pcb"), pcb);
  execFileSync(KICAD_CLI, ["pcb", "drc", "--schematic-parity", "--format", "json", "--severity-all", "-o", join(tmp, "drc.json"), join(tmp, "block.kicad_pcb")], { stdio: "ignore" });
  const report = JSON.parse(readFileSync(join(tmp, "drc.json"), "utf8"));
  const out = [];
  for (const key of ["violations", "unconnected_items", "schematic_parity"]) {
    for (const v of report[key] ?? []) {
      if (key === "violations" && v.type === "invalid_outline") continue;
      if (key === "violations" && v.type === "lib_footprint_mismatch" && /^Footprint U\d+$/.test(v.items?.[0]?.description ?? "")) continue; // modules with many pads round-trip differently from the library copy
      if (key === "violations" && v.type === "drill_out_of_range" && /\bof U\d+$/.test((v.items?.[0]?.description ?? ""))) continue; // thermal vias of a module footprint, from KiCad's library
      if (key === "unconnected_items" && spec.layout?.routed === false) continue; // a placement: the ratsnest is the point
      out.push(`${key}: ${v.type}: ${v.description} (${(v.items ?? []).map((i) => i.description).join("; ").slice(0, 120)})`);
    }
  }
  return out;
}

function writePcbImages(spec, pcbPath) {
  if (opts["no-images"] || !KICAD_CLI || !have(KICAD_CLI, ["version"])) return;
  const tmp = mkdtempSync(join(tmpdir(), "crossprobe-pcbimg-"));
  const copy = join(tmp, "block.kicad_pcb");
  writeFileSync(copy, readFileSync(pcbPath));
  execFileSync(KICAD_CLI, ["pcb", "export", "svg", "--layers", "F.Cu,B.Cu,F.Silkscreen,F.Courtyard", "--page-size-mode", "2", "--exclude-drawing-sheet", "-o", join(tmp, "board.svg"), copy], { stdio: "ignore" });
  let svg = readFileSync(join(tmp, "board.svg"), "utf8");
  // KiCad's own viewBox starts at the origin and can include empty space; fit the drawing instead.
  const xs = [], ys = [];
  for (const d of svg.matchAll(/\sd="([^"]*)"/g)) for (const p of d[1].matchAll(/(-?\d+\.?\d*)[ ,](-?\d+\.?\d*)/g)) (xs.push(+p[1]), ys.push(+p[2]));
  for (const c of svg.matchAll(/<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)"/g)) (xs.push(+c[1]), ys.push(+c[2]));
  const margin = 1.5;
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const [x, y, w, h] = [x0 - margin, y0 - margin, Math.max(...xs) - x0 + 2 * margin, Math.max(...ys) - y0 + 2 * margin];
  const bg = "#1b1d22";
  svg = svg
    .replace(/<!DOCTYPE[^>]*>\s*/, "")
    .replace(/ xmlns:svg="[^"]*"| xmlns:inkscape="[^"]*"/g, "")
    .replace(/width="[^"]*mm" height="[^"]*mm" viewBox="[^"]*">/, `width="${w}mm" height="${h}mm" viewBox="${x} ${y} ${w} ${h}">\n<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}" />`)
    .replace(/<title>[^<]*<\/title>/, `<title>${spec.title}: PCB layout</title>`)
    .replace(/<desc>[^<]*<\/desc>/, `<desc>PCB layout of ${spec.title}</desc>`)
    .replace(/(\d+\.\d{3})\d+/g, "$1");
  const dir = join(root, "blocks/images");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${spec.id}-pcb.svg`), svg);
  if (have("rsvg-convert", ["--version"])) {
    const inner = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"));
    const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${bg}"/><svg x="40" y="30" width="1120" height="570" viewBox="${x} ${y} ${w} ${h}" preserveAspectRatio="xMidYMid meet">${inner}</svg></svg>`;
    writeFileSync(join(tmp, "og.svg"), wrapper);
    execFileSync("rsvg-convert", ["-w", "1200", "-h", "630", join(tmp, "og.svg"), "-o", join(dir, `${spec.id}-pcb.png`)]);
  }
  console.log(`  layout image: blocks/images/${spec.id}-pcb.svg (${Math.round(svg.length / 1024)} KB, ${w.toFixed(1)} x ${h.toFixed(1)} mm)`);
}

let failed = false;
for (const file of readdirSync(join(root, "blocks/specs")).filter((f) => f.endsWith(".json")).sort()) {
  const spec = JSON.parse(readFileSync(join(root, "blocks/specs", file), "utf8"));
  const problems = [...checkSpecCitations(spec)];
  const sch = generateBlockSchematic(spec, symbols);
  problems.push(...verifyBlock(spec, sch, symbols).map((p) => p.message));
  if (problems.length) {
    failed = true;
    console.error(`✗ ${spec.id}`);
    for (const p of problems) console.error(`    ${p}`);
    continue;
  }
  let pcb;
  if (spec.layout) {
    pcb = generateBlockBoard(spec, sch, footprints);
    problems.push(...drcProblems(spec, sch, pcb));
    if (problems.length) {
      failed = true;
      console.error(`✗ ${spec.id} (layout)`);
      for (const p of problems) console.error(`    ${p}`);
      continue;
    }
  }
  const dir = join(outDir, LIB, `${spec.id}.kicad_block`);
  const files = {
    [`${spec.id}.kicad_sch`]: sch,
    [`${spec.id}.json`]: kicadBlockJson(spec),
    [`${spec.id}.crossprobe.json`]: JSON.stringify(blockManifest(spec, symbols), null, 2) + "\n",
    ...(pcb ? { [`${spec.id}.kicad_pcb`]: pcb } : {}),
  };
  if (opts.check) {
    for (const [name, text] of Object.entries(files)) {
      const p = join(dir, name);
      if (!existsSync(p) || readFileSync(p, "utf8") !== text) {
        failed = true;
        console.error(`✗ ${spec.id}: ${name} is out of date (run node scripts/build-blocks.mjs)`);
      }
    }
  } else {
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    console.log(`✓ ${spec.id}: ${spec.parts.length} parts, ${spec.checklist.length} checklist items, status ${spec.status}`);
    writeImages(spec, join(dir, `${spec.id}.kicad_sch`));
    if (pcb) writePcbImages(spec, join(dir, `${spec.id}.kicad_pcb`));
  }
}
if (opts.web && !failed) writeWeb(opts.web);
process.exit(failed ? 1 : 0);
