import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Board } from "@crossprobe/kicad-model";
import type { ModelSource } from "../load";
import { buildBoard3D, modelMatrix, placeholderBox } from "../three/board3d";
import { ModelLibrary } from "../three/models";
import { exportStep } from "../plot/step-export";
import { exportGlb } from "../plot/glb-export";
import { exportPly, exportStl } from "../plot/mesh-export";
import { Icon } from "./icons";
import type { Selection } from "./selection";

type Preset = "iso" | "top" | "bottom";

export function Board3DView({
  board,
  models,
  selection,
  onSelect,
  name,
}: {
  board: Board;
  /** File name for exports. */
  name?: string;
  models?: ModelSource;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<ModelLibrary | undefined>(undefined);
  const api = useRef<undefined | {
    setPreset: (p: Preset) => void;
    setComponents: (v: boolean) => void;
    highlight: (ref?: string) => void;
  }>(undefined);
  const [progress, setProgress] = useState<{ done: number; total: number; missing: number }>();
  const [showParts, setShowParts] = useState(true);
  const [stepNote, setStepNote] = useState<{ busy?: boolean; text: string }>();
  // Path variables other than KiCad's own (e.g. a company's ${ANT3DMDL}) can't be resolved in the browser.
  const unresolved = useMemo(() => {
    const vars = new Set<string>();
    for (const fp of board.footprints) for (const m of fp.models) for (const [, v] of m.path.matchAll(/\$\{([^}]+)\}/g)) if (v !== "KIPRJMOD" && !/^KICAD\d*_3DMODEL_DIR$|^KISYS3DMOD$/.test(v!)) vars.add(v!);
    return [...vars];
  }, [board]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#1b2230");
    scene.add(new THREE.HemisphereLight("#ffffff", "#3a4050", 1.6));
    const sun = new THREE.DirectionalLight("#ffffff", 2.2);
    sun.position.set(0.4, -0.6, 1);
    scene.add(sun);
    const under = new THREE.DirectionalLight("#ffffff", 0.8);
    under.position.set(-0.3, 0.5, -1);
    scene.add(under);

    const { group: boardGroup, bounds, seat } = buildBoard3D(board);
    scene.add(boardGroup);
    // For the browser checks: where models sit, and the board's z extent.
    (window as unknown as { __board3d?: unknown }).__board3d = { seat, board: (() => { const b = new THREE.Box3().setFromObject(boardGroup); return [b.min.z, b.max.z]; })() };
    const parts = new THREE.Group();
    scene.add(parts);

    const center = new THREE.Vector3(bounds.x + bounds.w / 2, -(bounds.y + bounds.h / 2), (seat.top + seat.bottom) / 2);
    const size = Math.max(bounds.w, bounds.h);
    const camera = new THREE.PerspectiveCamera(35, 1, size / 100, size * 50);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;

    const setPreset = (p: Preset) => {
      // Distance that fits the board in view, with some margin.
      const dist = (size / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.25;
      const dir = p === "top" ? new THREE.Vector3(0, -0.001, 1) : p === "bottom" ? new THREE.Vector3(0, -0.001, -1) : new THREE.Vector3(0.45, -0.9, 0.8);
      camera.up.set(0, 0, 1);
      camera.position.copy(center).addScaledVector(dir.normalize(), dist);
      controls.target.copy(center);
      controls.update();
    };
    setPreset("iso");

    // Selection highlight: a box around the footprint's models.
    const helper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color("#ff8a2a"));
    helper.visible = false;
    scene.add(helper);
    const byRef = new Map<string, THREE.Object3D>();
    const highlight = (ref?: string) => {
      const obj = ref ? byRef.get(ref) : undefined;
      helper.visible = !!obj && obj.visible;
      if (obj) helper.box.setFromObject(obj).expandByScalar(0.15);
    };

    // Footprints: real models where available, otherwise a placeholder box.
    const library = models ? new ModelLibrary(models) : undefined;
    libraryRef.current = library;
    let disposed = false;
    const fps = board.footprints.filter((f) => f.reference && (f.pads.length || f.models.length));
    const jobs = fps.map((fp) => {
      const holder = new THREE.Group();
      holder.userData.reference = fp.reference;
      parts.add(holder);
      byRef.set(fp.reference, holder);
      const visibleModels = fp.models.filter((m) => !m.hidden && m.path);
      return { fp, holder, visibleModels };
    });
    let done = 0;
    let missing = 0;
    const total = jobs.length;
    setProgress({ done, total, missing });
    for (const { fp, holder, visibleModels } of jobs) {
      const finish = (ok: boolean) => {
        if (disposed) return;
        if (!ok) {
          missing++;
          const box = placeholderBox(fp, seat);
          if (box) holder.add(box);
        }
        done++;
        if (done % 10 === 0 || done === total) setProgress({ done, total, missing });
      };
      if (!library || !visibleModels.length) {
        finish(false);
        continue;
      }
      Promise.all(visibleModels.map((m) => library.load(m.path).then((t) => ({ m, t })))).then((loaded) => {
        let any = false;
        for (const { m, t } of loaded) {
          if (!t) continue;
          const inst = t.clone();
          inst.applyMatrix4(modelMatrix(fp, m, seat));
          holder.add(inst);
          any = true;
        }
        finish(any);
      });
    }

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let frame = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    // Click (not drag) selects the component under the cursor.
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | undefined;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = raycaster.intersectObject(parts, true)[0];
      let o: THREE.Object3D | null = hit?.object ?? null;
      while (o && !o.userData.reference) o = o.parent;
      onSelectRef.current(o ? { kind: "component", reference: o.userData.reference as string } : null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    api.current = {
      setPreset,
      setComponents: (v) => {
        parts.visible = v;
        helper.visible = helper.visible && v;
      },
      highlight,
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      library?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [board, models]);

  useEffect(() => {
    api.current?.highlight(selection?.kind === "component" ? selection.reference : undefined);
  }, [selection, progress?.done]);

  return (
    <div className="viewport board3d" ref={host}>
      <div className="view-tools">
        <button onClick={() => api.current?.setPreset("top")} title="View from top"><Icon name="viewTop" /> Top</button>
        <button onClick={() => api.current?.setPreset("bottom")} title="View from bottom"><Icon name="viewBottom" /> Bottom</button>
        <button onClick={() => api.current?.setPreset("iso")} title="Angled view"><Icon name="cube" /> 3D</button>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showParts}
            onChange={(e) => {
              setShowParts(e.target.checked);
              api.current?.setComponents(e.target.checked);
            }}
          />
          Components
        </label>
        <button
          disabled={!!stepNote?.busy}
          title="Export the board and its parts' 3D models as a STEP assembly, as KiCad's STEP export does"
          onClick={async () => {
            setStepNote({ busy: true, text: "Building STEP…" });
            try {
              const r = await exportStep(board, name ?? "board", models);
              const url = URL.createObjectURL(new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: "model/step" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = `${name ?? "board"}.step`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setStepNote({ text: `STEP: the board and ${r.placed} part models${r.skipped.length ? ` · ${r.skipped.length} left out (no STEP model, or a scale it can't take): ${[...new Set(r.skipped.map((x) => x.reference))].slice(0, 6).join(", ")}` : ""}` });
            } catch (e) {
              setStepNote({ text: `STEP export failed: ${(e as Error).message}` });
            }
          }}
        >
          <Icon name="download" /> STEP
        </button>
        {(["GLB", "STL", "PLY"] as const).map((fmt) => (
          <button
            key={fmt}
            disabled={!!stepNote?.busy}
            title={`Export the board and its parts' 3D models (VRML ones too) as ${fmt === "GLB" ? "a GLB" : `an ${fmt}`} mesh, as KiCad's ${fmt} export does`}
            onClick={async () => {
              setStepNote({ busy: true, text: `Building ${fmt}…` });
              try {
                const base = name ?? "board";
                const r =
                  fmt === "GLB"
                    ? await exportGlb(board, base, libraryRef.current).then((g) => ({ ...g, blob: new Blob([g.bytes as Uint8Array<ArrayBuffer>], { type: "model/gltf-binary" }) }))
                    : await (fmt === "STL" ? exportStl : exportPly)(board, base, libraryRef.current);
                const url = URL.createObjectURL(r.blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${base}.${fmt.toLowerCase()}`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setStepNote({ text: `${fmt}: the board and ${r.placed} part models${r.skipped.length ? ` · ${r.skipped.length} without a model: ${[...new Set(r.skipped.map((x) => x.reference))].slice(0, 6).join(", ")}` : ""}` });
              } catch (e) {
                setStepNote({ text: `${fmt} export failed: ${(e as Error).message}` });
              }
            }}
          >
            <Icon name="download" /> {fmt}
          </button>
        ))}
      </div>
      {stepNote && !stepNote.busy && (
        <div className="progress muted step-note" onClick={() => setStepNote(undefined)}>
          {stepNote.text}
        </div>
      )}
      {progress && progress.done < progress.total && (
        <div className="progress">
          Loading 3D models… {progress.done}/{progress.total}
        </div>
      )}
      {progress && progress.done === progress.total && progress.missing > 0 && (
        <div className="progress muted" title="Footprints whose 3D model isn't available are shown as boxes.">
          {progress.missing} parts without a model shown as boxes
          {unresolved.length > 0 && <> · paths use {unresolved.map((v) => `\${${v}}`).join(", ")}, which isn't available here</>}
        </div>
      )}
    </div>
  );
}
