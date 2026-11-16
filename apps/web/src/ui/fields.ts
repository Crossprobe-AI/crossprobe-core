import type { EditOp } from "../edit/ops";
import type { ComponentInfo } from "../render/types";

/** Set a field on every unit of a part. */
export function fieldOps(c: ComponentInfo, name: string, value: string): EditOp[] {
  return c.units.map((u) => ({ op: "setField" as const, file: u.file, uuid: u.uuid, name, value, sheetPath: u.sheet }));
}
