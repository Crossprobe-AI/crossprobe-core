/**
 * Footprint picker for the board's footprint tool: searches KiCad's
 * footprint libraries (Library:Name) and loads the chosen .kicad_mod.
 * For parts that belong to the schematic, use Update PCB instead; this is
 * for board-only items such as mounting holes, fiducials and logos.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { bitmapToPolygons, logoFootprint } from "@crossprobe/kicad-model";
import { kicadFootprint, kicadFootprintIndex } from "../load";

export interface PlacingFootprint {
  libId: string;
  text: string;
}

let index: Promise<string[]> | undefined;

export function FootprintPicker({ placing, onPick }: { placing?: PlacingFootprint; onPick: (p: PlacingFootprint) => void }) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState<string>();

  useEffect(() => {
    index = kicadFootprintIndex();
    let live = true;
    index.then((i) => live && setAll(i));
    return () => {
      live = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!all) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = terms.length ? all.filter((id) => terms.every((t) => id.toLowerCase().includes(t))) : all.filter((id) => /^(MountingHole|Fiducial|TestPoint):/.test(id));
    return list.slice(0, 80);
  }, [all, query]);

  const pick = async (libId: string) => {
    setError(undefined);
    setLoading(libId);
    const text = await kicadFootprint(libId);
    setLoading(undefined);
    if (!text) setError(`${libId} isn't available`);
    else onPick({ libId, text });
  };

  return (
    <div className="part-picker" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <input autoFocus placeholder="Search footprints (e.g. “mountinghole m3”, “0603”)…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {error && <p className="error small">{error}</p>}
      <div className="part-list">
        {!all && <p className="muted small">Loading KiCad's footprint libraries…</p>}
        {all && !rows.length && <p className="muted small">No matches.</p>}
        {rows.map((id) => (
          <button key={id} className={placing?.libId === id ? "on" : ""} onClick={() => pick(id)}>
            <span className="part-name">{id.slice(id.indexOf(":") + 1)}</span>
            <span className="muted small">{loading === id ? "loading…" : id.slice(0, id.indexOf(":"))}</span>
          </button>
        ))}
      </div>
      <LogoMaker onPick={onPick} />
      <p className="muted small">For board-only parts. Parts from the schematic come in with Update PCB.</p>
    </div>
  );
}

const LOGO_LAYERS: Array<[string, string]> = [
  ["F.SilkS", "Silkscreen"],
  ["F.Cu", "Copper"],
  ["F.Mask", "Bare mask opening"],
];

/**
 * A logo or image from a picture: black-and-white by a threshold, traced at
 * 0.05 mm a pixel (coarser for very wide logos), placed as a board-only
 * footprint like KiCad's Image Converter makes (bottom side when viewed from below).
 */
function LogoMaker({ onPick }: { onPick: (p: PlacingFootprint) => void }) {
  const [open, setOpen] = useState(false);
  const [img, setImg] = useState<{ el: HTMLImageElement; name: string }>();
  const [width, setWidth] = useState(10);
  const [threshold, setThreshold] = useState(128);
  const [invert, setInvert] = useState(false);
  const [layer, setLayer] = useState("F.SilkS");
  const preview = useRef<HTMLCanvasElement>(null);

  // The ink mask at the board resolution.
  const mask = useMemo(() => {
    if (!img || !(width > 0)) return undefined;
    const aspect = img.el.naturalHeight / img.el.naturalWidth;
    const pixel = Math.max(0.05, width / 600);
    const w = Math.max(1, Math.round(width / pixel));
    const h = Math.max(1, Math.round((width * aspect) / pixel));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img.el, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const ink = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const [r, g, b, a] = [data[4 * i]!, data[4 * i + 1]!, data[4 * i + 2]!, data[4 * i + 3]!];
      const dark = a > 127 && 0.299 * r + 0.587 * g + 0.114 * b < threshold;
      ink[i] = (invert ? a > 127 && !dark : dark) ? 1 : 0;
    }
    return { ink, w, h, pixel };
  }, [img, width, threshold, invert]);

  useEffect(() => {
    const c = preview.current;
    if (!c || !mask) return;
    c.width = mask.w;
    c.height = mask.h;
    const ctx = c.getContext("2d")!;
    const out = ctx.createImageData(mask.w, mask.h);
    for (let i = 0; i < mask.ink.length; i++) {
      const on = mask.ink[i];
      out.data.set(on ? [242, 237, 161, 255] : [20, 24, 36, 255], 4 * i);
    }
    ctx.putImageData(out, 0, 0);
  }, [mask]);

  const load = (f: File) => {
    const el = new Image();
    el.onload = () => setImg({ el, name: f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_") || "Logo" });
    el.src = URL.createObjectURL(f);
  };
  const use = () => {
    if (!mask || !img) return;
    const polys = bitmapToPolygons(mask.ink, mask.w, mask.h, mask.pixel);
    if (!polys.length) return;
    const name = `${img.name}_${width}mm`;
    onPick({ libId: `Logo:${name}`, text: logoFootprint(polys, { name, layer }) });
    // Out of the way of the board while it's being placed.
    setOpen(false);
  };

  if (!open)
    return (
      <button className="link logo-open" onClick={() => setOpen(true)} title="A logo, mark or picture traced into the silkscreen (or copper)">
        Logo or image…
      </button>
    );
  return (
    <div className="logo-maker" onKeyDown={(e) => e.stopPropagation()}>
      <h4>Logo or image</h4>
      <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
      <label className="prop">
        <span>Width</span>
        <input type="number" min={1} step={0.5} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        <span className="muted small">mm</span>
      </label>
      <label className="prop">
        <span>Threshold</span>
        <input type="range" min={1} max={254} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
      </label>
      <label className="small">
        <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Invert (light parts are ink)
      </label>
      <label className="prop">
        <span>Layer</span>
        <select value={layer} onChange={(e) => setLayer(e.target.value)}>
          {LOGO_LAYERS.map(([l, label]) => (
            <option key={l} value={l}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {mask && <canvas ref={preview} className="logo-preview" title={`${mask.w}×${mask.h} px at ${mask.pixel} mm`} />}
      <div className="update-actions">
        <button onClick={() => setOpen(false)}>Close</button>
        <button className="primary" disabled={!mask || !mask.ink.some(Boolean)} onClick={use}>
          Place on board
        </button>
      </div>
    </div>
  );
}
