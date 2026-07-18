import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { home, tmpDir } from "../core/paths.js";
import type { ExtensionFactory } from "./api.js";

const moduleDir = fileURLToPath(new URL(".", import.meta.url)); // import.meta.dir is bun-only

// docs/ shipped next to src/ in dev. After bundling (dist/) or compiling,
// the module dir moves, so fall back to paths relative to the executable/cwd.
export function docsDir(): string {
  const candidates = [join(moduleDir, "..", "..", "docs"), join(process.execPath, "..", "docs"), join(process.cwd(), "docs")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "extensions.md"))) return dir;
  }
  return candidates[0];
}

export function globalExtensionsDir(): string {
  return join(home(), "extensions");
}

export function projectExtensionsDir(cwd: string): string {
  return join(cwd, ".devcode", "extensions");
}

// extensions/ shipped with the package: dev (src/extensions → repo root), npm
// (dist → package root), or next to a compiled binary. Deliberately NO cwd
// probe — a random project's extensions/ dir must never load as trusted
// bundled code.
export function bundledExtensionsDir(): string | undefined {
  const candidates = [join(moduleDir, "..", "..", "extensions"), join(process.execPath, "..", "extensions")];
  for (const dir of candidates) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    } catch {
      // keep probing
    }
  }
  return undefined;
}

export interface DiscoveredFile {
  path: string;
  source: "bundled" | "global" | "project";
}

export function discoverExtensionFiles(cwd: string = process.cwd()): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  const scan = (dir: string, source: DiscoveredFile["source"]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && /\.(ts|js)$/.test(name)) {
        out.push({ path: full, source });
      } else if (st.isDirectory()) {
        // one level of subdirs containing an index file
        for (const idx of ["index.ts", "index.js"]) {
          const idxPath = join(full, idx);
          if (existsSync(idxPath)) {
            out.push({ path: idxPath, source });
            break;
          }
        }
      }
    }
  };
  const bundled = bundledExtensionsDir();
  if (bundled) scan(bundled, "bundled");
  scan(globalExtensionsDir(), "global");
  scan(projectExtensionsDir(cwd), "project");
  return out;
}

export interface ExtensionLoadResult {
  loaded: { path: string; factory: ExtensionFactory }[];
  errors: { path: string; error: string }[];
}

const require = createRequire(import.meta.url);

// Resolves our own typebox install for extensions to share. Inside a compiled
// binary createRequire can't resolve from disk, so probe node_modules next to
// the executable directly. If neither exists, extensions value-importing
// typebox get a clear load error (type-only imports are always stripped).
function resolveTypebox(): string | undefined {
  try {
    return require.resolve("@sinclair/typebox");
  } catch {
    // compiled binary: fall through to filesystem probing
  }
  const exeDir = dirname(process.execPath);
  for (const base of [exeDir, join(exeDir, ".."), process.cwd()]) {
    try {
      const pkgDir = join(base, "node_modules", "@sinclair", "typebox");
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      const entry = pkg.exports?.["."]?.import?.default ?? pkg.exports?.["."]?.require?.default ?? pkg.module ?? pkg.main;
      if (entry) {
        const full = join(pkgDir, entry);
        if (existsSync(full)) return full;
      }
    } catch {
      // keep probing
    }
  }
  return undefined;
}

function makeJiti() {
  const alias: Record<string, string> = {
    devcode: fileURLToPath(new URL("./runtime-types.ts", import.meta.url)),
  };
  const typebox = resolveTypebox();
  if (typebox) alias["@sinclair/typebox"] = typebox;
  return createJiti(import.meta.url, {
    moduleCache: false, // re-read files on /reload
    alias,
  });
}

// jiti strips TS with its own babel asset, which lives in node_modules/jiti/dist.
// Inside a compiled binary that asset is unreachable.
function jitiBabelAvailable(): boolean {
  try {
    return existsSync(join(require.resolve("jiti"), "..", "..", "dist", "babel.cjs"));
  } catch {
    return false;
  }
}

// Fallback loader for compiled binaries: bundle each extension into a
// self-contained CJS module with Bun.build (TS natively supported, aliases
// via plugin), then evaluate it jiti-style — compiled binaries can't import
// more than one disk file, and data: URLs are size-limited, so everything
// happens in memory here.
async function loadViaBunBuild(files: DiscoveredFile[]): Promise<ExtensionLoadResult> {
  const loaded: ExtensionLoadResult["loaded"] = [];
  const errors: ExtensionLoadResult["errors"] = [];
  const typebox = resolveTypebox();
  const runtimeTypes = fileURLToPath(new URL("./runtime-types.ts", import.meta.url));
  for (const file of files) {
    try {
      const result = await Bun.build({
        entrypoints: [file.path],
        target: "bun",
        format: "cjs",
        plugins: [
          {
            name: "devcode-extension-aliases",
            setup(build) {
              if (typebox) build.onResolve({ filter: /^@sinclair\/typebox$/ }, () => ({ path: typebox }));
              build.onResolve({ filter: /^devcode$/ }, () => ({ path: runtimeTypes }));
            },
          },
        ],
      });
      if (!result.success) throw new Error(result.logs.map((l) => l.message).join("; ") || "bundle failed");
      // Bun's cjs output is an uninvoked (function(exports, require, module, ...) {...})
      // expression — instantiate and call it jiti-style.
      const code = await result.outputs[0].text();
      const bundleFn = new Function(`return (${code})`)() as (
        exports: unknown,
        require: unknown,
        module: { exports: any },
        filename: string,
        dirname: string,
      ) => void;
      const module = { exports: {} as any };
      bundleFn(module.exports, createRequire(file.path), module, file.path, dirname(file.path));
      const factory = module.exports.default ?? module.exports;
      if (typeof factory !== "function") throw new Error("default export is not a factory function");
      loaded.push({ path: file.path, factory });
    } catch (err) {
      errors.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { loaded, errors };
}

// Per-file try/catch: one broken extension never takes the others down.
export async function loadExtensions(files: DiscoveredFile[]): Promise<ExtensionLoadResult> {
  if (!jitiBabelAvailable() && typeof (Bun as any)?.build === "function") {
    return loadViaBunBuild(files); // compiled-binary path
  }
  const jiti = makeJiti();
  const loaded: ExtensionLoadResult["loaded"] = [];
  const errors: ExtensionLoadResult["errors"] = [];
  for (const file of files) {
    try {
      const factory = await jiti.import<ExtensionFactory>(file.path, { default: true });
      if (typeof factory !== "function") throw new Error("default export is not a factory function");
      loaded.push({ path: file.path, factory });
    } catch (err) {
      errors.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { loaded, errors };
}
