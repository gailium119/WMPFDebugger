import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const fridaDir = path.join(rootDir, "node_modules", "frida");
const fridaPkgPath = path.join(fridaDir, "package.json");
const bindingPath = path.join(fridaDir, "build", "frida_binding.node");
const required = process.argv.includes("--required");

const info = (message) => console.log(`[frida] ${message}`);

if (!existsSync(fridaPkgPath)) {
    const message = `frida is not installed at ${path.relative(rootDir, fridaDir)}; run the package manager first`;
    if (required) {
        console.error(`[frida] ${message}`);
        process.exit(1);
    }
    info(`${message}, skipping prebuilt check`);
    process.exit(0);
}

const isCompleteBinding = () => {
    if (!existsSync(bindingPath)) {
        return false;
    }
    // The real binding is well over 100 MiB. A small file is a failed/partial
    // build and must be replaced with the prebuilt binary.
    return statSync(bindingPath).size > 10 * 1024 * 1024;
};

if (isCompleteBinding()) {
    const size = Math.round(statSync(bindingPath).size / 1024 / 1024);
    info(`prebuilt binding already installed (${size} MiB)`);
    process.exit(0);
}

const pkg = JSON.parse(readFileSync(fridaPkgPath, "utf8"));
const pkgConfig = pkg.config || {};
const runtime = pkgConfig.runtime || "napi";
const abi = String(pkgConfig.target || "8");
const platform = process.platform;
const arch = process.arch;

info(`installing prebuilt frida ${pkg.version} binding for ${platform}/${arch}`);

const env = { ...process.env };
// Node >= 22.15 can trust the OS certificate store. Without this,
// prebuild-install fails behind a TLS-intercepting proxy and frida's install
// script falls back to a full source build, which needs a C++ toolchain.
if (
    process.allowedNodeEnvironmentFlags.has("--use-system-ca") &&
    !String(env.NODE_OPTIONS || "").includes("--use-system-ca")
) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --use-system-ca`.trim();
}

const require = createRequire(import.meta.url);
const prebuildBin = [
    path.join(rootDir, "node_modules", "prebuild-install", "bin.js"),
    path.join(fridaDir, "node_modules", "prebuild-install", "bin.js"),
].find((candidate) => existsSync(candidate));

if (prebuildBin) {
    const result = spawnSync(process.execPath, [prebuildBin, "--verbose"], {
        cwd: fridaDir,
        env,
        stdio: "inherit",
    });
    if (result.status === 0 && isCompleteBinding()) {
        info("prebuilt binding installed");
        process.exit(0);
    }
    info(
        `prebuild-install did not produce a binding (exit ${result.status ?? "unknown"}); trying direct download`,
    );
}

let downloadUrl;
try {
    const util = require(path.join(rootDir, "node_modules", "prebuild-install", "util.js"));
    downloadUrl = util.getDownloadUrl({
        pkg,
        runtime,
        abi,
        platform,
        arch,
        libc: "",
        "tag-prefix": "v",
    });
} catch {
    const name = pkg.name.replace(/^@[^/]+\//, "");
    downloadUrl = `https://github.com/frida/frida/releases/download/${pkg.version}/${name}-v${pkg.version}-${runtime}-v${abi}-${platform}-${arch}.tar.gz`;
}

info(`download URL: ${downloadUrl}`);

const tmpDir = mkdtempSync(path.join(tmpdir(), "wmpf-frida-"));
const archive = path.join(tmpDir, "frida_binding.tar.gz");

try {
    const curl = spawnSync(
        platform === "win32" ? "curl.exe" : "curl",
        ["-fL", "--retry", "3", "--connect-timeout", "30", "-o", archive, downloadUrl],
        { stdio: "inherit" },
    );
    if (curl.status !== 0) {
        throw new Error(`curl exited with ${curl.status}`);
    }

    const extract = spawnSync("tar", ["-xzf", archive, "-C", fridaDir], {
        stdio: "inherit",
    });
    if (extract.status !== 0) {
        throw new Error(`tar exited with ${extract.status}`);
    }

    if (!isCompleteBinding()) {
        throw new Error("archive did not contain build/frida_binding.node");
    }
    info("prebuilt binding installed");
} catch (error) {
    console.error(
        `[frida] failed to install the prebuilt binding: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`[frida] download it manually and extract it into ${fridaDir}:`);
    console.error(`[frida]   ${downloadUrl}`);
    process.exit(1);
} finally {
    rmSync(tmpDir, { recursive: true, force: true });
}
