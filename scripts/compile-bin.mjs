// RELEASE-T2: shared `bun build --compile` invocation for the three bins (chimerad, chimera,
// chimera-mcp), called by build-bins.sh. Goes through the JS API (not the `bun build` CLI) so
// the optional cross-compile target stays a plain argument and build failures surface as
// structured logs.
import { build } from "bun";

const [, , entry, outfile, target] = process.argv;
if (!entry || !outfile) {
  console.error("usage: bun compile-bin.mjs <entry.js> <outfile> [bun-target]");
  process.exit(1);
}

const result = await build({
  entrypoints: [entry],
  compile: { outfile, ...(target ? { target } : {}) },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built: ${outfile}`);
