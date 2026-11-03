// Synthetic fixtures only. No network, live installer, real HOME or credentials.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ACCLASS_INSTALLER_SHA256, ACCLASS_INSTALLER_URL, ACCLASS_MANIFEST_URL, ACCLASS_VERSION,
  DEFAULT_ACCLASS, createAcclassSetup, verifyInstallation,
} from "../acclass-setup.ts";

const installerBytes = Buffer.from("#!/bin/sh\n# synthetic installer; never executed\nexit 0\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const variants = ["q8", "q5", "fp32"];
const metadata = ["tokenizer.json", "config.json", "heads.json", "thresholds.json", "model_contract.json"];
const filesFor = (variant) => [...metadata, variant === "fp32" ? "model.safetensors" : "model.gguf"];
const bytesFor = (variant, name) => Buffer.from(`synthetic ${variant} ${name}\n`);
const asset = (bytes, url) => ({ url, sha256: hash(bytes), size: bytes.length });
function release() {
  return { schema: "acclass-release/2", version: ACCLASS_VERSION,
    binaries: { "linux-x86_64": asset("synthetic archive", "engine.tar.gz") },
    models: Object.fromEntries(variants.map((variant) => [variant,
      Object.fromEntries(filesFor(variant).map((name) => [name, asset(bytesFor(variant, name), `models/${variant}/${name}`)]))])) };
}
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "a-setup-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, ".acclass");
  const manifest = release();
  const calls = { fetch: [], spawn: [], consent: [] };
  const fetch = async (...args) => {
    calls.fetch.push(args);
    assert.equal(calls.consent.length, 1, "consent must precede every download");
    if (String(args[0]) === ACCLASS_INSTALLER_URL) return new Response(installerBytes);
    assert.equal(String(args[0]), ACCLASS_MANIFEST_URL);
    return new Response(JSON.stringify(manifest));
  };
  const record = async (root, variant, version = ACCLASS_VERSION) => {
    const files = ["bin/acclass", "release.json", ...filesFor(variant).map((name) => `model/${name}`)];
    await writeFile(join(root, "INSTALLATION.json"), JSON.stringify({ schema: "acclass-installation/2", version,
      model: variant, platform: "linux-x86_64", manifest_sha256: hash(await readFile(join(root, "release.json"))),
      files_sha256: Object.fromEntries(await Promise.all(files.map(async (name) => [name, hash(await readFile(join(root, name)))]))) }));
  };
  const install = async (variant = "q8") => {
    await mkdir(home, { mode: 0o700, recursive: true });
    const root = join(home, "versions", `${ACCLASS_VERSION}-${variant}`);
    await mkdir(join(root, "bin"), { mode: 0o700, recursive: true });
    await mkdir(join(root, "model"), { mode: 0o700 });
    await writeFile(join(root, "bin/acclass"), "#!/bin/sh\n# synthetic, never executed\nexit 0\n", { mode: 0o700 });
    for (const name of filesFor(variant)) await writeFile(join(root, "model", name), bytesFor(variant, name));
    await writeFile(join(root, "release.json"), JSON.stringify(manifest));
    await record(root, variant);
    await unlink(join(home, "current")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await symlink(`versions/${ACCLASS_VERSION}-${variant}`, join(home, "current"));
    return root;
  };
  const spawn = (command, args, options) => {
    calls.spawn.push({ command, args, options, installer: {
      bytes: readFileSync(args[0]), mode: lstatSync(args[0]).mode & 0o777,
      scratchMode: lstatSync(options.cwd).mode & 0o777,
    } });
    const child = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    queueMicrotask(async () => {
      try { await install(args[args.indexOf("--model") + 1]); child.emit("close", 0); }
      catch (error) { child.emit("error", error); }
    });
    return child;
  };
  const consent = async (request) => { calls.consent.push(request); return true; };
  return { temp, home, manifest, calls, fetch, spawn, install, record, consent,
    setup: (overrides = {}) => createAcclassSetup({ home, fetch, spawn, installerSha256: hash(installerBytes), ...overrides }) };
}
const enabled = (variant = "q8") => ({ enabled: true, variant });
const unavailable = (result) => { assert.equal(result.status, "unavailable"); assert.deepEqual(result.config, { provider: "none" }); };

// These checks intentionally use an injected synthetic installation root every time.
test("defaults, disabled, headless and declined do not fetch/spawn or create HOME", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(DEFAULT_ACCLASS, { enabled: true, variant: "q8" });
  assert.ok(Object.isFrozen(DEFAULT_ACCLASS));
  assert.equal(ACCLASS_VERSION, "1.0.0");
  assert.equal((await f.setup().ensureAcclass({ ...DEFAULT_ACCLASS, enabled: false }, f.consent)).status, "disabled");
  assert.equal((await f.setup().ensureAcclass(enabled())).status, "declined");
  assert.equal((await f.setup().ensureAcclass(enabled(), () => false)).status, "declined");
  assert.equal((await f.setup().ensureAcclass(enabled(), () => "yes")).status, "declined", "only explicit boolean consent is accepted");
  assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
  await assert.rejects(lstat(f.home), { code: "ENOENT" });
});

for (const variant of variants) {
  test(`consented ${variant} install: exact pinned arguments, minimal environment, private work and physical provider`, async (t) => {
    const f = await fixture(t);
    const result = await f.setup().ensureAcclass(enabled(variant), f.consent);
    assert.equal(result.status, "ready", result.message);
    assert.equal(f.calls.consent.length, 1);
    assert.equal(f.calls.consent[0].manifestUrl, ACCLASS_MANIFEST_URL);
    assert.equal(f.calls.consent[0].variant, variant);
    assert.match(f.calls.consent[0].message, /network.*https:.*LLM judge fallback/);
    assert.match(f.calls.consent[0].message, /downloads the installer and verifies it against a pinned SHA-256 hash/);
    assert.equal(f.calls.fetch.length, 2);
    assert.deepEqual(f.calls.fetch.map(([url]) => String(url)), [ACCLASS_MANIFEST_URL, ACCLASS_INSTALLER_URL]);
    for (const [, options] of f.calls.fetch) {
      assert.equal(options.redirect, "manual");
      assert.equal(options.credentials, "omit");
      assert.ok(options.signal instanceof AbortSignal);
    }
    const launch = f.calls.spawn[0];
    assert.equal(launch.command, "sh");
    assert.deepEqual(launch.installer, { bytes: installerBytes, mode: 0o600, scratchMode: 0o700 });
    assert.deepEqual(launch.args, [join(launch.options.cwd, "install.sh"), "--manifest", ACCLASS_MANIFEST_URL, "--manifest-sha256",
      hash(JSON.stringify(f.manifest)), "--model", variant, "--home", f.home]);
    assert.ok(!launch.args.includes("--pi"));
    assert.equal(launch.options.stdio, "ignore");
    assert.equal(launch.options.detached, true);
    assert.deepEqual(Object.keys(launch.options.env).sort(), ["HOME", "LANG", "PATH", "PYTHONNOUSERSITE", "PYTHONSAFEPATH", "TMPDIR"].sort());
    assert.equal(launch.options.env.HOME, dirname(f.home));
    assert.equal(launch.options.env.TMPDIR, launch.options.cwd);
    assert.ok(launch.options.cwd.startsWith(join(f.home, ".activity-")));
    await assert.rejects(lstat(launch.options.cwd), { code: "ENOENT" });
    const root = join(f.home, "versions", `1.0.0-${variant}`);
    assert.deepEqual(result.config, { provider: "acclass", binary: join(root, "bin/acclass"), model: join(root, "model"),
      socket: join(f.home, "run", `1.0.0-${variant}`, "ac.sock"), spawn: true, quant: variant === "fp32" ? "f32" : "q8" });
    for (const path of [f.home, join(f.home, "run"), dirname(result.config.socket)]) assert.equal((await lstat(path)).mode & 0o777, 0o700);
    assert.deepEqual(await verifyInstallation(f.home, variant), result.config);
    assert.equal((await f.setup().ensureAcclass(enabled(variant))).status, "ready", "installed matching variant needs no UI");
    assert.equal(f.calls.fetch.length, 2);
    assert.equal(f.calls.spawn.length, 1);
  });
}

test("valid upstream installation with 0755 root is reused with private sockets", async (t) => {
  const f = await fixture(t);
  await f.install();
  await chmod(f.home, 0o755);
  const result = await f.setup().ensureAcclass(enabled(), f.consent);
  assert.equal(result.status, "ready", result.message);
  assert.equal((await lstat(f.home)).mode & 0o777, 0o755, "existing root is not rewritten");
  for (const path of [join(f.home, "run"), dirname(result.config.socket)]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o700);
  }
  assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
});

test("valid variant mismatch asks once; denied mismatch remains offline", async (t) => {
  const f = await fixture(t);
  await f.install("q8");
  assert.equal((await f.setup().ensureAcclass(enabled("q5"))).status, "declined");
  assert.equal(f.calls.fetch.length, 0);
  const result = await f.setup().ensureAcclass(enabled("q5"), f.consent);
  assert.equal(result.status, "ready", result.message);
  assert.equal(f.calls.consent.length, 1);
  assert.equal(f.calls.spawn.length, 1);
  assert.equal(result.config.model, join(f.home, "versions/1.0.0-q5/model"));
});

test("existing corrupt different variant is not repaired and does not ask or fetch", async (t) => {
  const f = await fixture(t);
  const root = await f.install();
  await writeFile(join(root, "model/config.json"), "corrupt");
  unavailable(await f.setup().ensureAcclass(enabled("q5"), f.consent));
  assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
});

const corruptions = {
  "modified bytes": async (f, root) => writeFile(join(root, "model/config.json"), "corrupt"),
  "missing model file": async (f, root) => unlink(join(root, "model/heads.json")),
  "untracked regular file": async (f, root) => writeFile(join(root, "extra"), "synthetic"),
  "model symlink": async (f, root) => { await unlink(join(root, "model/heads.json")); await symlink("config.json", join(root, "model/heads.json")); },
  "directory symlink": async (f, root) => symlink("model", join(root, "linked")),
  "hardlinked file": async (f, root) => link(join(root, "model/heads.json"), join(root, "extra")),
  "special file": async (f, root) => {
    const socket = createServer();
    await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(join(root, "special"), accept); });
    f.closeSpecial = () => new Promise((accept) => socket.close(accept));
  },
  "non-executable binary": async (f, root) => chmod(join(root, "bin/acclass"), 0o600),
  "binary executable only by others": async (f, root) => chmod(join(root, "bin/acclass"), 0o601),
  "writable file": async (f, root) => chmod(join(root, "model/config.json"), 0o666),
  "writable version directory": async (f, root) => chmod(root, 0o777),
  "unsafe home mode": async (f) => chmod(f.home, 0o777),
  "wrong installation schema": async (f, root) => mutateInstallation(root, (v) => { v.schema = "wrong"; }),
  "wrong installation version": async (f, root) => mutateInstallation(root, (v) => { v.version = "9.0.0"; }),
  "wrong installation model": async (f, root) => mutateInstallation(root, (v) => { v.model = "q5"; }),
  "wrong installation platform": async (f, root) => mutateInstallation(root, (v) => { v.platform = "absent"; }),
  "wrong manifest digest": async (f, root) => mutateInstallation(root, (v) => { v.manifest_sha256 = "0".repeat(64); }),
  "inventory traversal": async (f, root) => mutateInstallation(root, (v) => { v.files_sha256["../escape"] = "0".repeat(64); }),
  "inventory absolute path": async (f, root) => mutateInstallation(root, (v) => { v.files_sha256["/escape"] = "0".repeat(64); }),
  "inventory invalid digest": async (f, root) => mutateInstallation(root, (v) => { v.files_sha256["model/config.json"] = "invalid"; }),
  "incomplete model even with rewritten inventory": async (f, root) => { await unlink(join(root, "model/config.json")); await mutateInstallation(root, (v) => { delete v.files_sha256["model/config.json"]; }); },
  "model differs from release despite matching inventory": async (f, root) => { await writeFile(join(root, "model/config.json"), "synthetic replacement"); await f.record(root, "q8"); },
  "release wrong version despite matching inventory": async (f, root) => { f.manifest.version = "9.0.0"; await writeFile(join(root, "release.json"), JSON.stringify(f.manifest)); await f.record(root, "q8"); },
  "release wrong schema despite matching inventory": async (f, root) => { f.manifest.schema = "wrong"; await writeFile(join(root, "release.json"), JSON.stringify(f.manifest)); await f.record(root, "q8"); },
  "unsafe run mode": async (f) => { await mkdir(join(f.home, "run")); await chmod(join(f.home, "run"), 0o755); },
  "run symlink": async (f, root) => symlink(root, join(f.home, "run")),
  "socket parent mode": async (f) => { await mkdir(join(f.home, "run/1.0.0-q8"), { recursive: true, mode: 0o700 }); await chmod(join(f.home, "run/1.0.0-q8"), 0o755); },
  "socket parent symlink": async (f, root) => { await mkdir(join(f.home, "run"), { mode: 0o700 }); await symlink(root, join(f.home, "run/1.0.0-q8")); },
  "socket regular file": async (f) => { await mkdir(join(f.home, "run/1.0.0-q8"), { recursive: true, mode: 0o700 }); await writeFile(join(f.home, "run/1.0.0-q8/ac.sock"), "synthetic"); },
  "socket symlink": async (f, root) => { await mkdir(join(f.home, "run/1.0.0-q8"), { recursive: true, mode: 0o700 }); await symlink(root, join(f.home, "run/1.0.0-q8/ac.sock")); },
  "versions symlink": async (f) => { await rename(join(f.home, "versions"), join(f.home, "moved")); await symlink("moved", join(f.home, "versions")); },
};
async function mutateInstallation(root, fn) {
  const path = join(root, "INSTALLATION.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  fn(value);
  await writeFile(path, JSON.stringify(value));
}
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`verification refuses ${name}; startup never silently reinstalls`, async (t) => {
    const f = await fixture(t);
    const root = await f.install();
    await corrupt(f, root);
    if (f.closeSpecial) t.after(f.closeSpecial);
    await assert.rejects(verifyInstallation(f.home));
    unavailable(await f.setup().ensureAcclass(enabled(), f.consent));
    assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
  });
}

for (const target of ["../escape", "/tmp/escape", "versions/../escape", "versions/1.0.0-q8/extra", "versions/9.0.0-q8"]) {
  test(`refuse unsafe/mismatched current target ${target}`, async (t) => {
    const f = await fixture(t);
    await f.install();
    await unlink(join(f.home, "current"));
    await symlink(target, join(f.home, "current"));
    await assert.rejects(verifyInstallation(f.home));
    unavailable(await f.setup().ensureAcclass(enabled(), f.consent));
    assert.equal(f.calls.consent.length, 0);
  });
}

test("retained corrupt destination without current is never silently replaced", async (t) => {
  const f = await fixture(t);
  const root = await f.install();
  await writeFile(join(root, "model/config.json"), "corrupt");
  await unlink(join(f.home, "current"));
  unavailable(await f.setup().ensureAcclass(enabled(), f.consent));
  assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
});

test("retained corrupt requested variant is not replaced when current is healthy", async (t) => {
  const f = await fixture(t);
  const corrupt = await f.install("q5");
  await writeFile(join(corrupt, "model/config.json"), "corrupt");
  await f.install("q8");
  unavailable(await f.setup().ensureAcclass(enabled("q5"), f.consent));
  assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
});

test("home symlink and symlink ancestor are refused without network", async (t) => {
  const f = await fixture(t);
  const real = join(f.temp, "physical");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, f.home);
  unavailable(await f.setup().ensureAcclass(enabled(), f.consent));
  await mkdir(join(real, "nested"), { mode: 0o700 });
  unavailable(await f.setup({ home: join(f.home, "nested") }).ensureAcclass(enabled(), f.consent));
  assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
});

test("wrong owner is refused", { skip: process.getuid?.() !== 0 }, async (t) => {
  const f = await fixture(t);
  const root = await f.install();
  await chown(join(root, "model/heads.json"), 65534, 65534);
  await assert.rejects(verifyInstallation(f.home), /owner/);
});

for (const url of ["http://example.invalid/model", "file:///tmp/synthetic", "/tmp/synthetic", "https://user:pass@example.invalid/model"]) {
  test(`preflight refuses unsafe model URL ${url.split(":")[0]}`, async (t) => {
    const f = await fixture(t);
    f.manifest.models.q8["model.gguf"].url = url;
    unavailable(await f.setup().ensureAcclass(enabled(), f.consent));
    assert.equal(f.calls.spawn.length, 0);
    await assert.rejects(lstat(f.home), { code: "ENOENT" });
  });
}

test("all asset URLs checked, including unselected binaries/models", async (t) => {
  const f = await fixture(t);
  f.manifest.binaries.unselected = asset("synthetic", "file:///tmp/synthetic");
  unavailable(await f.setup().ensureAcclass(enabled(), f.consent));
  assert.equal(f.calls.spawn.length, 0);
});

test("preflight refuses downgrade redirect before requesting it", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const result = await f.setup({ fetch: async () => { requests++; return new Response(null, { status: 302, headers: { location: "http://example.invalid/release.json" } }); } }).ensureAcclass(enabled(), f.consent);
  unavailable(result);
  assert.equal(requests, 1);
  assert.equal(f.calls.spawn.length, 0);
});

for (const [name, fetch] of [
  ["network error", async () => { throw new Error("synthetic offline"); }],
  ["HTTP failure", async () => new Response("missing", { status: 404 })],
  ["oversized manifest", async () => new Response(" ".repeat(2 * 1024 * 1024 + 1))],
  ["invalid JSON", async () => new Response("not JSON")],
  ["invalid version", async () => new Response(JSON.stringify({ ...release(), version: "9.0.0" }))],
  ["invalid model schema", async () => { const m = release(); delete m.models.q8["heads.json"]; return new Response(JSON.stringify(m)); }],
  ["missing selected model", async () => { const m = release(); delete m.models.q8; return new Response(JSON.stringify(m)); }],
]) {
  test(`manifest ${name} uses fallback, never spawns`, async (t) => {
    const f = await fixture(t);
    unavailable(await f.setup({ fetch }).ensureAcclass(enabled(), f.consent));
    assert.equal(f.calls.spawn.length, 0);
  });
}

test("pinned installer hash mismatch never writes or spawns", async (t) => {
  const f = await fixture(t);
  assert.equal(ACCLASS_INSTALLER_SHA256, "14a829520e50eea719fe1c11a1fb7cecbc6e5b4342933be79776bda9d65eef09");
  const result = await f.setup({ installerSha256: undefined }).ensureAcclass(enabled(), f.consent);
  unavailable(result);
  assert.match(result.message, /installer SHA-256 mismatch/);
  assert.equal(f.calls.fetch.length, 2, "manifest preflight precedes installer download");
  assert.equal(f.calls.spawn.length, 0);
  await assert.rejects(lstat(f.home), { code: "ENOENT" });
});

for (const [name, response] of [
  ["network error", async () => { throw new Error("synthetic offline"); }],
  ["HTTP failure", async () => new Response("missing", { status: 404 })],
  ["body read failure", async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic stream failure")); } }))],
  ["oversized bytes", async () => new Response(new Uint8Array(1024 * 1024 + 1))],
]) {
  test(`installer ${name} never writes or spawns`, async (t) => {
    const f = await fixture(t);
    const result = await f.setup({ fetch: (...args) => String(args[0]) === ACCLASS_INSTALLER_URL ? response() : f.fetch(...args) })
      .ensureAcclass(enabled(), f.consent);
    unavailable(result);
    if (name === "oversized bytes") assert.match(result.message, /installer exceeds size limit/);
    assert.equal(f.calls.spawn.length, 0);
    await assert.rejects(lstat(f.home), { code: "ENOENT" });
  });
}

for (const extra of [0, 1]) {
  test(`streamed installer ${extra ? "over" : "at"} 1 MiB cap`, async (t) => {
    const f = await fixture(t);
    const bytes = Buffer.alloc(1024 * 1024 + extra, "x");
    let cancelled = false;
    const chunks = [bytes.subarray(0, 512 * 1024), bytes.subarray(512 * 1024)];
    const result = await f.setup({ installerSha256: hash(bytes), fetch: (...args) => {
      if (String(args[0]) !== ACCLASS_INSTALLER_URL) return f.fetch(...args);
      return new Response(new ReadableStream({
        // Keep an oversized response open so rejection must cancel its reader.
        pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else if (!extra) controller.close(); },
        cancel() { cancelled = true; },
      }));
    } }).ensureAcclass(enabled(), f.consent);
    if (extra) {
      unavailable(result);
      assert.match(result.message, /installer exceeds size limit/);
      assert.equal(cancelled, true);
      assert.equal(f.calls.spawn.length, 0);
      await assert.rejects(lstat(f.home), { code: "ENOENT" });
    } else {
      assert.equal(result.status, "ready", result.message);
      assert.deepEqual(f.calls.spawn[0].installer.bytes, bytes);
    }
  });
}

test("installer follows HTTPS redirects with credentials omitted", async (t) => {
  const f = await fixture(t);
  const redirected = "https://assets.example.invalid/install.sh";
  const requests = [];
  const result = await f.setup({ fetch: (...args) => {
    if (String(args[0]) === ACCLASS_MANIFEST_URL) return f.fetch(...args);
    requests.push(args);
    return String(args[0]) === ACCLASS_INSTALLER_URL
      ? new Response(null, { status: 302, headers: { location: redirected } }) : new Response(installerBytes);
  } }).ensureAcclass(enabled(), f.consent);
  assert.equal(result.status, "ready", result.message);
  assert.deepEqual(requests.map(([url]) => String(url)), [ACCLASS_INSTALLER_URL, redirected]);
  for (const [, options] of requests) {
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
  }
});

for (const location of ["http://example.invalid/install.sh", "https://user:pass@example.invalid/install.sh", ACCLASS_INSTALLER_URL]) {
  test(`installer refuses unsafe or excessive redirects: ${location.split(":")[0]}`, async (t) => {
    const f = await fixture(t);
    let requests = 0;
    const result = await f.setup({ fetch: (...args) => {
      if (String(args[0]) === ACCLASS_MANIFEST_URL) return f.fetch(...args);
      requests++;
      return new Response(null, { status: 302, headers: { location } });
    } }).ensureAcclass(enabled(), f.consent);
    unavailable(result);
    assert.equal(requests, location === ACCLASS_INSTALLER_URL ? 6 : 1);
    assert.equal(f.calls.spawn.length, 0);
    await assert.rejects(lstat(f.home), { code: "ENOENT" });
  });
}

test("cancel during installer download never writes or spawns", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await f.setup({ fetch: (...args) => {
    if (String(args[0]) === ACCLASS_MANIFEST_URL) return f.fetch(...args);
    controller.abort();
    args[1].signal.throwIfAborted();
  } }).ensureAcclass(enabled(), f.consent, controller.signal);
  unavailable(result);
  assert.equal(f.calls.spawn.length, 0);
  await assert.rejects(lstat(f.home), { code: "ENOENT" });
});

test("installer failure and spawn error fall back; private scratch is removed", async (t) => {
  for (const kind of ["exit", "error"]) {
    const f = await fixture(t);
    let cwd;
    const result = await f.setup({ spawn: (_command, _args, options) => {
      cwd = options.cwd;
      const child = new EventEmitter();
      queueMicrotask(() => kind === "exit" ? child.emit("close", 7) : child.emit("error", new Error("synthetic spawn failure")));
      return child;
    } }).ensureAcclass(enabled(), f.consent);
    unavailable(result);
    assert.match(result.message, /failed|failure/);
    await assert.rejects(lstat(cwd), { code: "ENOENT" });
  }
});

test("installer success without artifacts is still refused", async (t) => {
  const f = await fixture(t);
  const result = await f.setup({ spawn: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0)); return child; } }).ensureAcclass(enabled(), f.consent);
  unavailable(result);
});

test("cancel before consent and during preflight never spawns", async (t) => {
  const f = await fixture(t);
  unavailable(await f.setup().ensureAcclass(enabled(), f.consent, AbortSignal.abort()));
  assert.deepEqual(f.calls, { fetch: [], spawn: [], consent: [] });
  const controller = new AbortController();
  const result = await f.setup({ fetch: async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
  } }).ensureAcclass(enabled(), f.consent, controller.signal);
  unavailable(result);
  assert.equal(f.calls.spawn.length, 0);
});

test("cancel running installer kills it and removes private scratch", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let killed = false;
  let cwd;
  const result = await f.setup({ spawn: (_command, _args, options) => {
    cwd = options.cwd;
    const child = new EventEmitter();
    child.kill = (signal) => { assert.equal(signal, "SIGTERM"); killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
    queueMicrotask(() => controller.abort());
    return child;
  } }).ensureAcclass(enabled(), f.consent, controller.signal);
  unavailable(result);
  assert.match(result.message, /cancelled/);
  assert.equal(killed, true);
  await assert.rejects(lstat(cwd), { code: "ENOENT" });
});

test("refuse installer-controlled versions/link hazards", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, "versions"), { mode: 0o700, recursive: true });
  await symlink(f.temp, join(f.home, "versions/unsafe"));
  unavailable(await f.setup().ensureAcclass(enabled(), f.consent));
  assert.equal(f.calls.spawn.length, 0);
});

test("private existing socket is accepted; unsafe socket permissions are refused", async (t) => {
  const f = await fixture(t);
  await f.install();
  const config = await verifyInstallation(f.home);
  const server = createServer();
  t.after(() => new Promise((accept) => server.close(accept)));
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(config.socket, accept); });
  await chmod(config.socket, 0o600);
  assert.deepEqual(await verifyInstallation(f.home), config);
  await chmod(config.socket, 0o660);
  await assert.rejects(verifyInstallation(f.home), /owner\/mode|socket/);
});

test("installer timeout is bounded; stuck process gets a forced kill after grace", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  let started;
  const launched = new Promise((accept) => { started = accept; });
  const promise = f.setup({ spawn: () => {
    const child = new EventEmitter();
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
      return true;
    };
    started();
    return child;
  } }).ensureAcclass(enabled(), f.consent);
  await launched;
  t.mock.timers.tick(15 * 60 * 1000);
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(2000);
  const result = await promise;
  unavailable(result);
  assert.match(result.message, /timeout/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
