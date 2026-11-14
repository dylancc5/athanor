/**
 * Module resolution hook for running these tests on bare Node.
 *
 * No test runner is installed in this project and we may not add one, so the
 * tests run on `node --test` with Node's built-in TypeScript type stripping.
 * Two things need patching for that to work:
 *
 *  1. Extensionless specifiers. Node uses strict ESM resolution, so
 *     `./normalize` does not find `normalize.ts`. (We cannot write
 *     `./normalize.ts` in the source either — the project tsconfig does not
 *     set `allowImportingTsExtensions`, so that would fail `tsc --noEmit`.)
 *  2. The `@/` path alias from tsconfig.
 *
 * We also force `format: "module"` for .ts files: `web/package.json` has no
 * `"type": "module"`, so without this Node would try to load our ESM source
 * as CommonJS.
 *
 * Run with:
 *   cd web && node --import ./components/three/structure/__tests__/register.mjs \
 *     --test components/three/structure/__tests__/
 */

import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ -> structure -> three -> components -> web
const WEB_ROOT = path.resolve(here, "..", "..", "..", "..");

const TS_EXTENSIONS = [".ts", ".tsx", ".mts"];

function isFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Try `base`, `base.ts`, `base/index.ts`, ... and return the first hit. */
function resolveCandidate(base) {
  if (isFile(base) && path.extname(base) !== "") return base;
  for (const ext of TS_EXTENSIONS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of TS_EXTENSIONS) {
    const idx = path.join(base, "index" + ext);
    if (isFile(idx)) return idx;
  }
  if (isFile(base + ".js")) return base + ".js";
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;

    if (specifier.startsWith("@/")) {
      base = path.join(WEB_ROOT, specifier.slice(2));
    } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : WEB_ROOT;
      base = path.resolve(path.dirname(parentPath), specifier);
    }

    if (base) {
      const hit = resolveCandidate(base);
      if (hit) {
        const ext = path.extname(hit);
        return {
          url: pathToFileURL(hit).href,
          shortCircuit: true,
          format: TS_EXTENSIONS.includes(ext) ? "module-typescript" : "module",
        };
      }
    }

    return nextResolve(specifier, context);
  },
});
