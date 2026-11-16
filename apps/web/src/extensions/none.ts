/**
 * The extensions a build includes. This one has none: the editor on its own.
 * A build that adds extensions names its own module for `@crossprobe/extensions`
 * (build-setup.ts).
 */
import type { Extension } from "./api";

export const extensions: Extension[] = [];
