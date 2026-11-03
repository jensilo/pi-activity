import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { EvidenceProviderConfig } from "./evidence-provider.js";

export type AcclassSettings = { enabled: boolean; variant: "q8" | "q5" | "fp32" };
export const DEFAULT_ACCLASS: Readonly<AcclassSettings> = Object.freeze({ enabled: true, variant: "q8" });
export const ACCLASS_VERSION = "1.0.0";
export const ACCLASS_MANIFEST_URL = "https://github.com/jensilo/acclass/releases/download/v1.0.0/release.json";
export const ACCLASS_INSTALLER_URL = "https://github.com/jensilo/acclass/releases/download/v1.0.0/install.sh";
export const ACCLASS_INSTALLER_SHA256 = "b7e2171e0545dcdb32d0b7c71041e7758cfeb9cfcdd6178b36f911dc0e087976";
const VARIANTS = ["q8", "q5", "fp32"] as const;
const METADATA = ["tokenizer.json", "config.json", "heads.json", "thresholds.json", "model_contract.json"];
const MAX_JSON = 2 * 1024 * 1024;
const MAX_INSTALLER = 1024 * 1024;
const INSTALL_TIMEOUT = 15 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;
type Variant = AcclassSettings["variant"];
type Json = Record<string, any>;

export type AcclassConsent = {
  version: string;
  variant: Variant;
  manifestUrl: string;
  message: string;
};
export type AcclassConsentCallback = (request: AcclassConsent) => boolean | Promise<boolean>;
export type AcclassSetupResult = {
  status: "ready" | "disabled" | "declined" | "unavailable";
  config: EvidenceProviderConfig;
  message?: string;
};
/** Test seams only. home is the installation root, not the user's HOME. */
export type AcclassSetupDependencies = {
  home?: string;
  fetch?: typeof globalThis.fetch;
  installerSha256?: string;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
};

function requireSafe(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`acclass: ${message}`);
}
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function modelFiles(variant: Variant): string[] {
  return [...METADATA, variant === "fp32" ? "model.safetensors" : "model.gguf"];
}
function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}
function safeRelative(name: string): boolean {
  return !!name && !name.includes("\\") && !name.includes("\0") &&
    name.split("/").every((part) => !!part && part !== "." && part !== "..");
}
function httpsUrl(value: string): URL {
  const url = new URL(value, ACCLASS_MANIFEST_URL);
  requireSafe(url.protocol === "https:" && !url.username && !url.password && !value.startsWith("/") && !value.includes("\\"),
    "asset URLs must use HTTPS without credentials or local paths");
  return url;
}
function validateManifest(manifest: unknown): asserts manifest is Json {
  requireSafe(object(manifest) && manifest.schema === "acclass-release/2" && manifest.version === ACCLASS_VERSION &&
    object(manifest.binaries) && Object.keys(manifest.binaries).length > 0 && object(manifest.models), "invalid release schema/version");
  const asset = (entry: unknown) => {
    requireSafe(object(entry) && typeof entry.url === "string" && !!entry.url && SHA256.test(entry.sha256) &&
      Number.isSafeInteger(entry.size) && entry.size >= 0, "invalid release asset");
    httpsUrl(entry.url);
  };
  for (const entry of Object.values(manifest.binaries)) asset(entry);
  requireSafe(Object.keys(manifest.models).every((name) => VARIANTS.includes(name as Variant)), "invalid model variant");
  for (const [variant, files] of Object.entries(manifest.models)) {
    requireSafe(object(files) && sameNames(Object.keys(files), modelFiles(variant as Variant)), "incomplete release model");
    for (const entry of Object.values(files)) asset(entry);
  }
}
async function maybeStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function owned(stat: Awaited<ReturnType<typeof lstat>>, path: string): void {
  requireSafe(typeof process.getuid === "function" && stat.uid === process.getuid() && (stat.mode & 0o022) === 0,
    `unsafe owner/mode: ${path}`);
}
async function directory(path: string, privateMode = false): Promise<void> {
  const stat = await lstat(path);
  requireSafe(stat.isDirectory() && !stat.isSymbolicLink(), `not a physical directory: ${path}`);
  owned(stat, path);
  if (privateMode) requireSafe((stat.mode & 0o777) === 0o700, `directory must be private 0700: ${path}`);
}
/** Refuse symlinks in all path components; never chmod or repair an unsafe root. */
async function checkHome(home: string, create = false): Promise<boolean> {
  requireSafe(isAbsolute(home) && resolve(home) === home && home !== parse(home).root, "home must be an absolute normalized path");
  const ancestors: string[] = [];
  for (let parent = dirname(home); parent !== parse(parent).root; parent = dirname(parent)) ancestors.unshift(parent);
  for (const parent of ancestors) requireSafe((await lstat(parent)).isDirectory(), `symlink/non-directory ancestor: ${parent}`);
  if (!await maybeStat(home)) {
    if (!create) return false;
    await mkdir(home, { mode: 0o700 });
  }
  // Upstream installs can be 0755 under umask 022. Only payload integrity and
  // write access matter here; the socket's run directories remain private.
  await directory(home);
  return true;
}
async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await directory(path, true);
}
async function withRegular<T>(path: string, fn: (file: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    requireSafe(before.isFile() && before.nlink === 1, `not a regular unlinked file: ${path}`);
    owned(before, path);
    const result = await fn(file);
    const after = await file.stat();
    const linked = await lstat(path);
    requireSafe(before.ino === linked.ino && before.dev === linked.dev && before.size === after.size &&
      before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `file changed during verification: ${path}`);
    return result;
  } finally { await file.close(); }
}
async function readJson(path: string): Promise<{ value: unknown; digest: string }> {
  return withRegular(path, async (file) => {
    requireSafe((await file.stat()).size <= MAX_JSON, "JSON exceeds size limit");
    const bytes = await file.readFile();
    requireSafe(bytes.length <= MAX_JSON, "JSON exceeds size limit");
    return { value: JSON.parse(bytes.toString("utf8")), digest: createHash("sha256").update(bytes).digest("hex") };
  });
}
async function hashFile(path: string): Promise<string> {
  return withRegular(path, async (file) => {
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  });
}
async function inventory(root: string): Promise<string[]> {
  const files: string[] = [];
  let count = 0;
  const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
    requireSafe(depth <= 16, "installation directory too deep");
    await directory(path);
    for (const name of await readdir(path)) {
      requireSafe(++count <= 4096 && safeRelative(name), "invalid/oversized installation inventory");
      const relative = prefix + name;
      const full = join(path, name);
      const stat = await lstat(full);
      owned(stat, full);
      if (stat.isDirectory()) await walk(full, `${relative}/`, depth + 1);
      else {
        requireSafe(stat.isFile() && stat.nlink === 1, `symlink/special file in installation: ${relative}`);
        files.push(relative);
      }
    }
  };
  await walk(root, "", 0);
  return files;
}
function parseTarget(target: string): { version: string; variant: Variant } {
  const match = /^versions\/(\d+\.\d+\.\d+)-(q8|q5|fp32)$/.exec(target);
  requireSafe(match, "unsafe current/previous link");
  return { version: match[1], variant: match[2] as Variant };
}

async function verifyVersion(home: string, target: string, variant?: Variant): Promise<EvidenceProviderConfig> {
  const selected = parseTarget(target);
  requireSafe(selected.version === ACCLASS_VERSION && (variant === undefined || selected.variant === variant), "installation version/model mismatch");
  await directory(join(home, "versions"));
  const root = join(home, target);
  await directory(root);
  const actual = await inventory(root);
  const { value: installation } = await readJson(join(root, "INSTALLATION.json"));
  requireSafe(object(installation) && installation.schema === "acclass-installation/2" &&
    installation.version === selected.version && installation.model === selected.variant &&
    typeof installation.platform === "string" && SHA256.test(installation.manifest_sha256) && object(installation.files_sha256),
  "invalid installation schema/version/model");
  const expected = Object.keys(installation.files_sha256);
  requireSafe(expected.every((name) => safeRelative(name) && name !== "INSTALLATION.json" && SHA256.test(installation.files_sha256[name])) &&
    sameNames(actual, [...expected, "INSTALLATION.json"]), "installation inventory mismatch");
  for (const name of expected) requireSafe(await hashFile(join(root, name)) === installation.files_sha256[name], `hash mismatch: ${name}`);
  const { value: manifest, digest } = await readJson(join(root, "release.json"));
  requireSafe(digest === installation.manifest_sha256, "release.json manifest hash mismatch");
  validateManifest(manifest);
  requireSafe(Object.hasOwn(manifest.binaries, installation.platform), "installation platform absent from release");
  const files = manifest.models[selected.variant];
  requireSafe(object(files) && sameNames(await readdir(join(root, "model")), modelFiles(selected.variant)), "incomplete installed model");
  for (const name of modelFiles(selected.variant)) {
    const path = join(root, "model", name);
    requireSafe(files[name].sha256 === installation.files_sha256[`model/${name}`] && (await lstat(path)).size === files[name].size,
      `model differs from release: ${name}`);
  }
  const binary = join(root, "bin/acclass");
  requireSafe(expected.includes("bin/acclass") && ((await lstat(binary)).mode & 0o100) !== 0, "missing/non-executable binary");
  return { provider: "acclass", binary: await realpath(binary), model: await realpath(join(root, "model")),
    socket: join(home, "run", `${selected.version}-${selected.variant}`, "ac.sock"),
    spawn: true, quant: selected.variant === "fp32" ? "f32" : "q8" };
}

/** Hash every installed file on each call. Throws on missing or unsafe artifacts.
 * Only current is a permitted artifact link. Returned paths are physical pins.
 * Creates/checks private run directories; never downloads or starts a process. */
export async function verifyInstallation(home = join(homedir(), ".acclass"), variant?: Variant): Promise<EvidenceProviderConfig> {
  requireSafe(await checkHome(home), "installation is missing");
  const current = join(home, "current");
  requireSafe((await lstat(current)).isSymbolicLink(), "current must be a managed symlink");
  const target = await readlink(current);
  const config = await verifyVersion(home, target, variant);
  requireSafe(await readlink(current) === target, "current changed during verification");
  await privateDirectory(join(home, "run"));
  await privateDirectory(dirname(config.socket!));
  const socket = config.socket!;
  const socketStat = await maybeStat(socket);
  if (socketStat) {
    owned(socketStat, socket);
    requireSafe(socketStat.isSocket() && (socketStat.mode & 0o077) === 0, "unsafe socket type/mode");
  }
  return config;
}

async function download(fetcher: typeof fetch, source: string, limit: number, label: string, signal?: AbortSignal): Promise<Buffer> {
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  let url = httpsUrl(source);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url, { redirect: "manual", signal: bounded, credentials: "omit" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      requireSafe(location && redirects < 5, `invalid ${label} redirect`);
      url = httpsUrl(new URL(location, url).href);
      continue;
    }
    requireSafe(response.ok && response.body, `${label} download failed`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        requireSafe((size += value.length) <= limit, `${label} exceeds size limit`);
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  throw new Error("acclass: too many redirects");
}

async function preflight(fetcher: typeof fetch, variant: Variant, signal?: AbortSignal): Promise<string> {
  const bytes = await download(fetcher, ACCLASS_MANIFEST_URL, MAX_JSON, "manifest", signal);
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  validateManifest(manifest);
  requireSafe(Object.hasOwn(manifest.models, variant), "requested model absent from release");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Check installer-controlled paths before allowing the upstream installer to mutate them. */
async function installerLayout(home: string): Promise<void> {
  for (const name of ["bin", "model", "previous"]) {
    const path = join(home, name);
    const stat = await maybeStat(path);
    if (!stat) continue;
    requireSafe(stat.isSymbolicLink(), `unmanaged installer path: ${name}`);
    const target = await readlink(path);
    if (name === "previous") parseTarget(target);
    else requireSafe(target === `current/${name}`, `unsafe installer link: ${name}`);
  }
  requireSafe(!await maybeStat(join(home, ".lock")), "another install is running or a stale installer lock needs manual review");
  const versions = join(home, "versions");
  if (await maybeStat(versions)) {
    await directory(versions);
    for (const name of await readdir(versions)) await verifyVersion(home, `versions/${name}`);
  }
}

function runInstaller(spawner: NonNullable<AcclassSetupDependencies["spawn"]>, args: string[], home: string, scratch: string,
  signal?: AbortSignal): Promise<void> {
  return new Promise((accept, reject) => {
    signal?.throwIfAborted();
    const child = spawner("sh", args, { detached: true, stdio: "ignore", cwd: scratch,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: dirname(home), TMPDIR: scratch,
        LANG: "C", PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1" } });
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(-child.pid, kind); } catch { child.kill(kind); }
      } else child.kill(kind);
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      // Python turns SIGTERM into KeyboardInterrupt, so its lock/staging contexts
      // unwind. Force-kill only a stuck process group after the grace period.
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const abort = () => stop(new Error("acclass: installation cancelled"));
    const timer = setTimeout(() => stop(new Error("acclass: installer timeout")), INSTALL_TIMEOUT);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (failure || code !== 0) reject(failure ?? new Error(`acclass: installer failed (${code})`));
      else accept();
    });
    if (signal?.aborted) abort();
  });
}

/** Factory for offline tests. Production uses ensureAcclass below. */
export function createAcclassSetup(dependencies: AcclassSetupDependencies = {}) {
  const home = dependencies.home ?? join(homedir(), ".acclass");
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const spawner = dependencies.spawn ?? nodeSpawn;
  return {
    verifyInstallation: (variant?: Variant) => verifyInstallation(home, variant),
    async ensureAcclass(settings: AcclassSettings, consent?: AcclassConsentCallback, signal?: AbortSignal): Promise<AcclassSetupResult> {
      const fallback = (status: AcclassSetupResult["status"], message?: string): AcclassSetupResult => ({ status, config: { provider: "none" }, ...(message ? { message } : {}) });
      if (!settings.enabled) return fallback("disabled");
      try {
        requireSafe(VARIANTS.includes(settings.variant), "invalid model variant");
        signal?.throwIfAborted();
        const exists = await checkHome(home);
        if (exists && await maybeStat(join(home, "current"))) {
          // Verify even a different installed variant before offering an install.
          // Corruption must not be hidden by replacement or an automatic repair.
          const config = await verifyInstallation(home);
          if (config.model === join(home, "versions", `${ACCLASS_VERSION}-${settings.variant}`, "model")) {
            signal?.throwIfAborted();
            return { status: "ready", config };
          }
        }
        // A retained destination (even without current) is an existing install,
        // not permission to silently replace corrupt files after a generic prompt.
        if (exists) await installerLayout(home);
        const request: AcclassConsent = { version: ACCLASS_VERSION, variant: settings.variant, manifestUrl: ACCLASS_MANIFEST_URL,
          message: `Download and install acclass ${ACCLASS_VERSION} (${settings.variant} model) over the network from ${ACCLASS_MANIFEST_URL}? ` +
            "Activity downloads the installer and verifies it against a pinned SHA-256 hash before running it. " +
            "If declined or unavailable, Activity uses the LLM judge fallback." };
        if (!consent || await consent(request) !== true) return fallback("declined");
        signal?.throwIfAborted();
        const digest = await preflight(fetcher, settings.variant, signal);
        const installerBytes = await download(fetcher, ACCLASS_INSTALLER_URL, MAX_INSTALLER, "installer", signal);
        requireSafe(createHash("sha256").update(installerBytes).digest("hex") ===
          (dependencies.installerSha256 ?? ACCLASS_INSTALLER_SHA256), "installer SHA-256 mismatch");
        signal?.throwIfAborted();
        await checkHome(home, true);
        await installerLayout(home);
        // Recheck after the consent/network await; never overwrite a newly corrupt current.
        if (await maybeStat(join(home, "current"))) await verifyInstallation(home);
        const scratch = await mkdtemp(join(home, ".activity-"));
        try {
          await directory(scratch, true);
          const installer = join(scratch, "install.sh");
          const file = await open(installer, "wx", 0o600);
          try { await file.writeFile(installerBytes); }
          finally { await file.close(); }
          await runInstaller(spawner, [installer, "--manifest", ACCLASS_MANIFEST_URL, "--manifest-sha256", digest,
            "--model", settings.variant, "--home", home], home, scratch, signal);
        } finally { await rm(scratch, { recursive: true, force: true }); }
        signal?.throwIfAborted();
        const config = await verifyInstallation(home, settings.variant);
        signal?.throwIfAborted();
        return { status: "ready", config };
      } catch (error) {
        return fallback("unavailable", error instanceof Error ? error.message : "acclass setup failed; using LLM judge");
      }
    },
  };
}

/** Disabled/headless/declined paths never fetch or spawn. Errors select LLM fallback. */
export async function ensureAcclass(settings: AcclassSettings, consent?: AcclassConsentCallback, signal?: AbortSignal): Promise<AcclassSetupResult> {
  return createAcclassSetup().ensureAcclass(settings, consent, signal);
}
