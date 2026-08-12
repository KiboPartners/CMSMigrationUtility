/**
 * Bootstrap for @kibo-cms-clone-tool/shared.
 *
 * Loaded via tsconfig "ts-node.require" / `ts-node -r ./register-shared.js` /
 * postinstall so a missing node_modules file: link (common after a partial
 * Windows install) does not break `require("@kibo-cms-clone-tool/shared")`.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const PKG = "@kibo-cms-clone-tool/shared";
const root = __dirname;
const sharedDir = path.join(root, "src", "shared");
const distMain = path.join(sharedDir, "dist", "index.js");
const tsMain = path.join(sharedDir, "index.ts");

try {
  require("tsconfig-paths/register");
} catch {
  /* optional — resolver hook below still covers the shared package */
}

function ensureLink() {
  const linkDir = path.join(root, "node_modules", "@kibo-cms-clone-tool");
  const linkPath = path.join(linkDir, "shared");
  if (!fs.existsSync(sharedDir) || fs.existsSync(linkPath)) return;
  fs.mkdirSync(linkDir, { recursive: true });
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(sharedDir, linkPath, type);
}

try {
  ensureLink();
} catch {
  /* non-fatal — Module hook still resolves in this process */
}

const target = fs.existsSync(distMain) ? distMain : tsMain;
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === PKG) {
    return orig.call(this, target, parent, isMain, options);
  }
  return orig.call(this, request, parent, isMain, options);
};
