/**
 * Test runner. No test framework is installed, so this uses the jiti that
 * ships with Next to execute the TypeScript test files directly, teaching it
 * the `@/*` path alias from tsconfig.
 *
 *   cd web && node lib/run-tests.mjs
 */
import { createJiti } from "jiti";
import { resolve } from "node:path";

const root = process.cwd();
const jiti = createJiti(import.meta.url, {
  alias: { "@": root },
  interopDefault: true,
});

const files = process.argv.slice(2);
const targets =
  files.length > 0 ? files : ["lib/campaign-state.test.ts", "lib/tour.test.ts"];

let failed = false;
for (const file of targets) {
  try {
    await jiti.import(resolve(root, file));
  } catch (err) {
    failed = true;
    console.error(`\n${file} threw:`);
    console.error(err);
  }
}
process.exit(failed ? 1 : 0);
