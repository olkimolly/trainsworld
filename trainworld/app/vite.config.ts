import { copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
// TW_PACKS: a frozen copy instead (pipeline/freeze.py build, T-928)
const PACKS = process.env.TW_PACKS ? resolve(process.env.TW_PACKS) : resolve(here, "../data/packs");
/** The packs the game opens: the registry's cities (T-125), and its regional market. Pipeline output, gitignored. */
const REGISTRY = JSON.parse(readFileSync(resolve(here, "src/game/registry.json"), "utf8")) as { cities: { id: string }[]; market: { pack: string } };
const CITIES = REGISTRY.cities.map((c) => c.id);
/** T-2901: the terrain classes of the world's land, one file per degree block (pipeline/world_terrain.py), at
 * `packs/terrain-world/`; TW_TERRAIN_WORLD: another copy. A build holds them as hard links (0.7 GB, 19k files), and
 * tools/deploy.py publishes them on their own, not with each release. */
const TERRAIN_WORLD = process.env.TW_TERRAIN_WORLD ? resolve(process.env.TW_TERRAIN_WORLD) : resolve(here, "../data/terrain-world-v2");
/** T-1285: the world's coarse water (pipeline/world_water.py), served at `packs/world.water`; TW_WORLD_WATER: another copy. */
const WORLD_WATER = process.env.TW_WORLD_WATER ? resolve(process.env.TW_WORLD_WATER) : resolve(here, "../data/terrain/world.water");
/** T-279: the market's routed drives (pipeline/market_drives.py), served at `packs/market-drives.bin`; TW_MARKET_DRIVES: another copy. */
const MARKET_DRIVES = process.env.TW_MARKET_DRIVES ? resolve(process.env.TW_MARKET_DRIVES) : join(PACKS, "market-drives.bin");

/** TW_LINK_PACKS=1 (snapbuild.cmd): a build holds the packs as hard links to the data files instead of copies, 6 GB in
 * 5 s instead of 35. Safe because every pipeline writer replaces a pack (a .part renamed over it), never rewrites it in
 * place (pipeline/freeze.py relies on the same rule); a copy where a link is refused (another volume). Never over an
 * existing file: it could be a link to the source, and copying onto that would truncate the data file. */
const LINK_PACKS = process.env.TW_LINK_PACKS === "1";
function put(src: string, dst: string): void {
  if (!LINK_PACKS) return copyFileSync(src, dst);
  try {
    if (existsSync(dst)) unlinkSync(dst);
    linkSync(src, dst);
  } catch (e) {
    if (existsSync(dst)) throw e;
    copyFileSync(src, dst);
  }
}

/**
 * City packs at `packs/<city>.json`, `.bin`, `.boundary.geojson`, `.market.json` (T-377) and `.places.json` (the OSM place
 * list, pipeline/places.py, fetched only when search or station naming needs it) beside the page: served from
 * data/packs/ by the dev server and copied into dist/packs/ by a build. The clock worker reads the
 * water mask from it with a Range request, the demand workers the cells. `packs/outlines.json` (T-800) is the one file
 * shared by every zone.
 */
function packs(): Plugin {
  return {
    name: "trainworld-packs",
    configureServer(server) {
      server.middlewares.use("/packs/market-drives.bin", (_req, res) => {
        // missing, a 404: every drive in the market is then the rule's
        if (!existsSync(MARKET_DRIVES)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", statSync(MARKET_DRIVES).size);
        createReadStream(MARKET_DRIVES).pipe(res);
      });
      server.middlewares.use("/packs/terrain-world", (req, res) => {
        const file = join(TERRAIN_WORLD, (req.url ?? "").split("?")[0].replace(/^\/+/, ""));
        // never a 200 with the page for a file that is not there: the clock worker reads a failure as a failure
        if (!file.startsWith(TERRAIN_WORLD) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", statSync(file).size);
        createReadStream(file).pipe(res);
      });
      server.middlewares.use("/packs", (req, res, next) => {
        const file = join(PACKS, (req.url ?? "").split("?")[0].replace(/^\/+/, ""));
        if (!file.startsWith(PACKS) || !existsSync(file)) return next();
        const size = statSync(file).size;
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", file.endsWith(".geojson") ? "application/geo+json" : file.endsWith(".json") ? "application/json" : "application/octet-stream");
        if (range) {
          const a = Number(range[1]), b = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${a}-${b}/${size}`);
          res.setHeader("Content-Length", b - a + 1);
          createReadStream(file, { start: a, end: b }).pipe(res);
        } else {
          res.setHeader("Content-Length", size);
          createReadStream(file).pipe(res);
        }
      });
      server.middlewares.use("/packs/world.water", (_req, res) => {
        // missing, a 404: the clock worker then leaves the sea outside the zones as land
        if (!existsSync(WORLD_WATER)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", statSync(WORLD_WATER).size);
        createReadStream(WORLD_WATER).pipe(res);
      });
    },
    writeBundle(opts) {
      const out = join(opts.dir ?? resolve(here, "dist"), "packs");
      mkdirSync(out, { recursive: true });
      for (const c of CITIES)
        for (const ext of [".json", ".bin", ".boundary.geojson", ".places.json", ".market.json"]) {
          const src = join(PACKS, c + ext);
          if (existsSync(src)) put(src, join(out, c + ext));
          else if (ext === ".places.json") this.warn(`place list missing: ${src} (build it with pipeline/places.py ${c})`);
          else if (ext === ".market.json") this.warn(`market pack missing: ${src} (build it with pipeline/market_zones.py ${c})`);
          else this.warn(`city pack missing: ${src} (build it with pipeline/build_city.py ${c})`);
        }
      if (existsSync(join(TERRAIN_WORLD, "index.bin"))) {
        const world = join(out, "terrain-world");
        mkdirSync(world, { recursive: true });
        for (const f of readdirSync(TERRAIN_WORLD)) {
          const dst = join(world, f);
          if (existsSync(dst)) continue;
          try { linkSync(join(TERRAIN_WORLD, f), dst); } catch { copyFileSync(join(TERRAIN_WORLD, f), dst); }
        }
      } else this.warn("terrain blocks missing: run pipeline/world_terrain.py build");
      if (existsSync(WORLD_WATER)) put(WORLD_WATER, join(out, "world.water"));
      else this.warn("world water mask missing: run pipeline/world_water.py build");
      if (existsSync(MARKET_DRIVES)) put(MARKET_DRIVES, join(out, "market-drives.bin"));
      else this.warn("market drives missing: run pipeline/market_drives.py build");
      // T-800: every zone's coarse outline (pipeline/zone_outlines.py); without it every zone shows (T-1006)
      const outlines = join(PACKS, "outlines.json");
      if (existsSync(outlines)) put(outlines, join(out, "outlines.json"));
      else this.warn("coarse zone outlines missing: run pipeline/zone_outlines.py");
      // T-731: the real networks a sandbox can start from (pipeline/realnet.py ship)
      const real = join(PACKS, "real");
      if (existsSync(real)) {
        mkdirSync(join(out, "real"), { recursive: true });
        for (const f of readdirSync(real)) if (f.endsWith(".save")) put(join(real, f), join(out, "real", f));
      } else this.warn("real networks missing: run pipeline/realnet.py ship");
      // T-727: the real network's routing graphs the track tool snaps along (pipeline/realgraph.py)
      const graphs = join(PACKS, "realgraph");
      if (existsSync(graphs)) {
        mkdirSync(join(out, "realgraph"), { recursive: true });
        for (const f of readdirSync(graphs)) if (f.endsWith(".rgr") || f === "index.json") put(join(graphs, f), join(out, "realgraph", f));
      } else this.warn("real-network graphs missing: run pipeline/realgraph.py <regions>");
    },
  };
}

/** The start menu's version: the commit count, so 8800 and the published page can be told apart at a glance
 * (the orchestrator names it in its reports); "dev" on the dev server, whose tree may not match a commit. */
function version(): string {
  if (process.argv.includes("build") === false) return "dev";
  try {
    return execSync("git rev-list --count HEAD", { cwd: dirname(fileURLToPath(import.meta.url)) }).toString().trim();
  } catch {
    return "dev";
  }
}

// T-328: the app build, part of the demand cache's key: new at each build and dev-server start. T-3707: also the stamp
// a score is sent with; tools/deploy.py reads it from dist/build.json into the site's list of published builds.
const BUILD = Date.now().toString(36);
const VERSION = version();
/** T-3707: a build from the public repo (tools/opensource adds this file there) marks its games modded. */
const UNOFFICIAL = existsSync(resolve(here, "unofficial-build.txt"));

function buildStamp(): Plugin {
  return {
    name: "tw-build-stamp",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify({ build: BUILD, version: VERSION }) + "\n" });
    },
  };
}

/**
 * trainsworld public copy: the game's data (city packs, terrain, outlines, real networks) is 6 GB and is not in git.
 * With no local `data/packs` folder, the dev server answers every `/packs/...` and `/noritetsu/...` request itself.
 *
 * Local mirror (this fork): each request is first looked up in `data/mirror/`, laid out exactly like the published
 * bucket (`data/mirror/trainworld/<version>/...`, `data/mirror/trainworld/terrain-world/v2/...`,
 * `data/mirror/noritetsu/...`). `tools/mirror-data.mjs` fills it with the whole published copy. A file that is not
 * there yet is fetched whole from data.anita.garden, saved into the mirror, then served from it, so anything the
 * game asks for while online is kept for later.
 *   TW_DATA_VERSION=<folder>   which published data version (default: data-version.txt beside this repo's trainworld/)
 *   TW_MIRROR=<dir>            another mirror folder (default: data/mirror)
 *   TW_DATA=off                never fetch; serve the mirror only (a missing file is a 404)
 * With a local `data/packs` (or TW_PACKS) this does nothing.
 */
function dataFallback(): Plugin {
  const ORIGIN = "https://data.anita.garden";
  const versionFile = resolve(here, "../data-version.txt");
  const version = process.env.TW_DATA_VERSION || (existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "");
  const MIRROR = process.env.TW_MIRROR ? resolve(process.env.TW_MIRROR) : resolve(here, "../data/mirror");
  const online = process.env.TW_DATA !== "off";
  const on = !!version && !existsSync(PACKS);
  /** one download per file, shared by the requests that arrive while it runs */
  const pending = new Map<string, Promise<number>>();

  /** Fetch the whole file into the mirror (a .part renamed over it, so a cut download never looks finished);
   * resolves to the HTTP status, 200 when the file is now in the mirror. */
  function download(remote: string, file: string): Promise<number> {
    let p = pending.get(file);
    if (!p) {
      p = (async () => {
        const r = await fetch(`${ORIGIN}/${remote}`);
        if (r.status !== 200) return r.status;
        const body = Buffer.from(await r.arrayBuffer());
        await mkdir(dirname(file), { recursive: true });
        const part = `${file}.${process.pid}.part`;
        await writeFile(part, body);
        await rename(part, file);
        return 200;
      })().finally(() => pending.delete(file));
      pending.set(file, p);
    }
    return p;
  }

  function serve(file: string, req: any, res: any): void {
    const size = statSync(file).size;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", file.endsWith(".geojson") ? "application/geo+json" : file.endsWith(".json") ? "application/json" : "application/octet-stream");
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range && Number(range[1]) < size) {
      const a = Number(range[1]), b = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${a}-${b}/${size}`);
      res.setHeader("Content-Length", b - a + 1);
      createReadStream(file, { start: a, end: b }).pipe(res);
    } else {
      res.setHeader("Content-Length", size);
      createReadStream(file).pipe(res);
    }
  }

  return {
    name: "trainsworld-data-fallback",
    configureServer(server) {
      if (!on) return;
      console.log(`[data] data version ${version}: serving ${MIRROR}${online ? `, fetching what is missing from ${ORIGIN} and keeping it` : " only (TW_DATA=off)"}`);
      server.middlewares.use(async (req: any, res: any, next: () => void) => {
        let url: string;
        try {
          url = decodeURIComponent((req.url ?? "").split("?")[0]);
        } catch {
          return next();
        }
        let remote: string;
        if (url.startsWith("/packs/terrain-world/")) remote = `trainworld/terrain-world/v2/${url.slice("/packs/terrain-world/".length)}`;
        else if (url.startsWith("/packs/")) remote = `trainworld/${version}/${url.slice("/packs/".length)}`;
        else if (url.startsWith("/noritetsu/")) remote = url.slice(1);
        else return next();
        const file = resolve(MIRROR, remote);
        // nothing outside the mirror, and no folder listings
        if (!file.startsWith(MIRROR + sep) || remote.endsWith("/")) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          if (!(existsSync(file) && statSync(file).isFile())) {
            const status = online ? await download(remote, file) : 404;
            if (status !== 200) {
              res.statusCode = status;
              res.end();
              return;
            }
          }
          serve(file, req, res);
        } catch {
          res.statusCode = 502;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  // Served under /trainworld/ by maps/serve.py, so every URL in the build must be relative.
  base: "./",
  worker: { format: "es" },
  define: { __TW_BUILD__: JSON.stringify(BUILD), __TW_VERSION__: JSON.stringify(VERSION), __TW_UNOFFICIAL__: JSON.stringify(UNOFFICIAL) },
  build: { outDir: "dist", target: "es2022" },
  // T-682: the real-network layer reads noritetsu's tiles beside the game (map/realNetwork.ts); 8800 serves them
  // at /noritetsu/ and sends no CORS headers, so the dev server passes the path through
  server: { proxy: { "/noritetsu": "http://localhost:8800" } },
  plugins: [dataFallback(), packs(), buildStamp()],
});
