/**
 * Loading footprint 3D models (STEP via OpenCascade in workers, VRML via
 * three.js) into reusable templates. Each distinct model file is loaded once
 * and shared by every footprint that uses it.
 */
import * as THREE from "three";
import { VRMLLoader } from "three/examples/jsm/loaders/VRMLLoader.js";
import type { ModelSource } from "../load";

interface StepMesh {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array;
  colors: Float32Array;
}

/** A small pool of classic workers running occt-import-js (wasm). */
class StepPool {
  private workers: Worker[] = [];
  private queue: Array<{ id: number; buffer: ArrayBuffer }> = [];
  private idle: Worker[] = [];
  private pending = new Map<number, { resolve: (m: StepMesh[]) => void; reject: (e: Error) => void }>();
  private nextId = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(`${import.meta.env.BASE_URL}occt/step-worker.js`);
      w.onmessage = (e: MessageEvent<{ id: number; meshes?: StepMesh[]; error?: string }>) => {
        const job = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (e.data.error) job?.reject(new Error(e.data.error));
        else job?.resolve(e.data.meshes!);
        this.idle.push(w);
        this.pump();
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  convert(buffer: ArrayBuffer): Promise<StepMesh[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, buffer });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      w.postMessage(job, [job.buffer]);
    }
  }

  dispose() {
    this.workers.forEach((w) => w.terminate());
  }
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const stepMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.25, roughness: 0.55 });

function stepToGroup(meshes: StepMesh[]): THREE.Group {
  const group = new THREE.Group();
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    if (m.normals) g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    for (let i = 0; i < m.colors.length; i++) m.colors[i] = toLinear(m.colors[i]!);
    g.setAttribute("color", new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    if (!m.normals) g.computeVertexNormals();
    g.computeBoundingBox();
    group.add(new THREE.Mesh(g, stepMaterial));
  }
  return group;
}

export class ModelLibrary {
  private pool = new StepPool(Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2)));
  private cache = new Map<string, Promise<THREE.Group | undefined>>();

  constructor(private source: ModelSource) {}

  /** A template group in millimetres, or undefined when the model is unavailable. */
  load(path: string): Promise<THREE.Group | undefined> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.fetchAndConvert(path).catch(() => undefined);
      this.cache.set(path, p);
    }
    return p;
  }

  private async fetchAndConvert(path: string): Promise<THREE.Group | undefined> {
    const data = await this.source(path);
    if (!data) return undefined;
    if (data.format === "wrl") {
      const scene = new VRMLLoader().parse(new TextDecoder().decode(data.buffer), "");
      // VRML models are authored in 0.1 inch units.
      scene.scale.setScalar(2.54);
      const g = new THREE.Group();
      g.add(scene);
      return g;
    }
    return stepToGroup(await this.pool.convert(data.buffer));
  }

  dispose() {
    this.pool.dispose();
  }
}
