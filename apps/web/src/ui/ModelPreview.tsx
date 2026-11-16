/**
 * The footprint's 3D model on a patch of board, as KiCad's footprint properties preview it:
 * pads on a 1.6 mm slab, the model placed with the 3D view's transform (modelMatrix), so
 * the offset and rotation fields can be checked as they're edited.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Footprint } from "@crossprobe/kicad-model";
import type { ModelSource } from "../load";
import { ModelLibrary } from "../three/models";
import { modelMatrix } from "../three/board3d";

const T = 1.6;

export function ModelPreview({ fp, models }: { fp: Footprint; models?: ModelSource }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
  const model = fp.models[0];
  const key = JSON.stringify(model ?? null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    const w = el.clientWidth || 260, h = 200;
    renderer.setSize(w, h);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#3a4050", 1.6));
    const sun = new THREE.DirectionalLight("#ffffff", 1.4);
    sun.position.set(20, -30, 40);
    scene.add(sun);
    // The slab: the pads' extent plus a margin.
    const xs = fp.pads.flatMap((p) => [p.at.x - p.size.x / 2, p.at.x + p.size.x / 2]);
    const ys = fp.pads.flatMap((p) => [p.at.y - p.size.y / 2, p.at.y + p.size.y / 2]);
    const [x0, x1, y0, y1] = xs.length ? [Math.min(...xs) - 2, Math.max(...xs) + 2, Math.min(...ys) - 2, Math.max(...ys) + 2] : [-5, 5, -5, 5];
    const slab = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, T), new THREE.MeshStandardMaterial({ color: "#1f5a37", roughness: 0.7 }));
    slab.position.set((x0 + x1) / 2, -(y0 + y1) / 2, T / 2);
    scene.add(slab);
    const padMat = new THREE.MeshStandardMaterial({ color: "#c9a548", metalness: 0.6, roughness: 0.35 });
    for (const p of fp.pads) {
      if (!p.layers.some((l) => l === "F.Cu" || l === "*.Cu")) continue;
      const g = p.shape === "circle" ? new THREE.CylinderGeometry(p.size.x / 2, p.size.x / 2, 0.04, 24).rotateX(Math.PI / 2) : new THREE.BoxGeometry(p.size.x, p.size.y, 0.04);
      const m = new THREE.Mesh(g, padMat);
      m.position.set(p.at.x, -p.at.y, T + 0.02);
      m.rotation.z = (p.rotation * Math.PI) / 180;
      scene.add(m);
    }
    const size = Math.max(x1 - x0, y1 - y0);
    const camera = new THREE.PerspectiveCamera(35, w / h, size / 100, size * 50);
    camera.up.set(0, 0, 1);
    const center = new THREE.Vector3((x0 + x1) / 2, -(y0 + y1) / 2, T);
    camera.position.copy(center).add(new THREE.Vector3(0.45, -0.9, 0.8).normalize().multiplyScalar(size * 1.8));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.update();
    let frame = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();
    const library = models ? new ModelLibrary(models) : undefined;
    let gone = false;
    setState("loading");
    if (model?.path && library) {
      void library.load(model.path).then((tmpl) => {
        if (gone) return;
        if (!tmpl) return setState("missing");
        const at = { ...fp, at: { x: 0, y: 0 }, rotation: 0, layer: "F.Cu" } as Footprint;
        const obj = tmpl.clone();
        obj.applyMatrix4(modelMatrix(at, model, { top: T, bottom: 0 }));
        scene.add(obj);
        setState("ok");
      });
    } else setState("missing");
    return () => {
      gone = true;
      cancelAnimationFrame(frame);
      controls.dispose();
      library?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, models, fp.pads.length]);
  return (
    <div className="model-preview">
      <div ref={host} />
      {state === "loading" && <p className="muted small">Loading the model…</p>}
      {state === "missing" && model?.path && <p className="muted small">The model file isn't available here: {model.path.split("/").pop()}</p>}
    </div>
  );
}
