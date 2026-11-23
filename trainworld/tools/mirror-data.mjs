// Copies the game's whole published data (city packs, terrain blocks, real networks, noritetsu's rail tiles) from
// data.anita.garden into data/mirror/, laid out like the bucket, so the dev server (vite.config.ts, dataFallback)
// can run the game with no network to that host. The bucket has no listing, so the file names are built the way
// the page builds them: every registry city's five pack files, the terrain blocks index.bin lists, the real-network
// saves and graphs, and noritetsu's per-region archives.
//
//   node trainworld/tools/mirror-data.mjs                 download what is not in the mirror yet (safe to rerun)
//   node trainworld/tools/mirror-data.mjs --plan          only count the files and stop
//   node trainworld/tools/mirror-data.mjs --retry-missing also ask again for files the host answered 404 for
//   --jobs=N (default 4), --version=<folder>, --mirror=<dir>

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TW = resolve(here, "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name) => process.argv.includes(`--${name}`);

const ORIGIN = "https://data.anita.garden";
const VERSION = arg("version") || process.env.TW_DATA_VERSION || readFileSync(join(TW, "data-version.txt"), "utf8").trim();
const MIRROR = resolve(arg("mirror") || process.env.TW_MIRROR || join(TW, "data", "mirror"));
const JOBS = Math.max(1, Math.min(8, Number(arg("jobs") || 4)));
const MISSING = join(MIRROR, `_missing-${VERSION}.txt`);
const LOG = join(MIRROR, `_log-${VERSION}.txt`);
const PACK_EXT = [".json", ".bin", ".boundary.geojson", ".places.json", ".market.json"];

mkdirSync(MIRROR, { recursive: true });
const log = (s) => {
  const line = `${new Date().toISOString().slice(0, 19).replace("T", " ")}  ${s}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};

const local = (remote) => join(MIRROR, ...remote.split("/"));
const have = (remote) => existsSync(local(remote)) && statSync(local(remote)).isFile();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Download one file into the mirror. Returns its size, or "missing" for a 404. Retries other failures. */
async function get(remote) {
  const file = local(remote);
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${ORIGIN}/${remote}`, { headers: { "user-agent": "trainsworld-mirror" }, signal: AbortSignal.timeout(300_000) });
      if (r.status === 404 || r.status === 403) return "missing";
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      const part = `${file}.part`;
      writeFileSync(part, body);
      renameSync(part, file);
      return body.length;
    } catch (e) {
      if (attempt >= 6) throw new Error(`${remote}: ${e.message}`);
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
    }
  }
}

/** An index file: kept in the mirror, read from it. */
async function index(remote) {
  if (!have(remote)) {
    const got = await get(remote);
    if (got === "missing") return null;
  }
  return readFileSync(local(remote));
}

const json = (buf) => (buf ? JSON.parse(buf.toString("utf8")) : null);

async function plan() {
  const files = [];
  const tw = `trainworld/${VERSION}`;

  const registry = JSON.parse(readFileSync(join(TW, "app/src/game/registry.json"), "utf8"));
  for (const c of registry.cities) for (const ext of PACK_EXT) files.push(`${tw}/${c.id}${ext}`);
  files.push(`${tw}/outlines.json`, `${tw}/market-drives.bin`, `${tw}/world.water`);

  const real = JSON.parse(readFileSync(join(TW, "app/src/game/realNetworks.json"), "utf8"));
  for (const id of real) files.push(`${tw}/real/${id}.save`);

  const graphs = json(await index(`${tw}/realgraph/index.json`));
  if (graphs) {
    files.push(`${tw}/realgraph/index.json`);
    for (const cc of graphs.regions ?? []) files.push(`${tw}/realgraph/${cc}.rgr`);
    for (const cc of graphs.extra ?? []) files.push(`${tw}/realgraph/${cc}.x.rgr`);
  } else log("warning: realgraph/index.json not found");

  // terrain-world/v2/index.bin: "TWI1", south, rows, west, cols (little endian), then one bit per degree block
  const ix = await index("trainworld/terrain-world/v2/index.bin");
  if (ix && ix.toString("latin1", 0, 4) === "TWI1") {
    files.push("trainworld/terrain-world/v2/index.bin");
    const south = ix.readInt16LE(4), rows = ix.readUInt16LE(6), west = ix.readInt16LE(8), cols = ix.readUInt16LE(10);
    for (let i = 0; i < rows * cols; i++)
      if ((ix[16 + (i >> 3)] >> (i & 7)) & 1) files.push(`trainworld/terrain-world/v2/${south + Math.floor(i / cols)}_${west + (i % cols)}.terrain`);
  } else log("warning: terrain index.bin not found or not readable");

  const regions = json(await index("noritetsu/regions.json"));
  if (regions?.regions) {
    files.push("noritetsu/regions.json");
    for (const cc of Object.keys(regions.regions)) files.push(`noritetsu/data/${cc}.pmtiles`);
  } else log("warning: noritetsu/regions.json not found");
  const extra = json(await index("noritetsu/data/extra.json"));
  if (extra) {
    files.push("noritetsu/data/extra.json");
    for (const cc of Array.isArray(extra) ? extra : Object.keys(extra)) files.push(`noritetsu/data/${cc}_extra.pmtiles`);
  }
  return [...new Set(files)];
}

const mb = (n) => (n / 2 ** 20).toFixed(1) + " MB";

async function main() {
  log(`data version ${VERSION}, mirror ${MIRROR}`);
  const all = await plan();
  const missingBefore = new Set(existsSync(MISSING) && !flag("retry-missing") ? readFileSync(MISSING, "utf8").split("\n").filter(Boolean) : []);
  const todo = all.filter((f) => !have(f) && !missingBefore.has(f));
  log(`${all.length} files in all, ${all.length - todo.length} already here or known missing, ${todo.length} to download`);
  if (flag("plan") || !todo.length) return;
  if (flag("retry-missing") && existsSync(MISSING)) unlinkSync(MISSING);

  let done = 0, bytes = 0, missing = 0, failed = 0;
  const t0 = Date.now();
  const report = () => {
    const s = (Date.now() - t0) / 1000, rate = bytes / Math.max(1, s);
    const left = todo.length - done, eta = done ? (s / done) * left : 0;
    log(`${done}/${todo.length} files, ${mb(bytes)} at ${mb(rate)}/s, ${missing} not on the host, ${failed} failed, about ${Math.ceil(eta / 60)} min left`);
  };
  let next = 0, lastReport = Date.now();
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      try {
        const got = await get(f);
        if (got === "missing") {
          missing++;
          appendFileSync(MISSING, f + "\n");
        } else bytes += got;
      } catch (e) {
        failed++;
        log(`failed: ${e.message}`);
      }
      done++;
      if (Date.now() - lastReport > 30_000) {
        lastReport = Date.now();
        report();
      }
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
  report();
  log(failed ? `finished with ${failed} failures: run this again to retry them` : "finished");
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  log(`stopped: ${e.stack || e}`);
  process.exitCode = 1;
});
