import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "prospect-feature-"));
const port = 4199;
const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
  cwd: root,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), RUNTIME_STATE_PATH: path.join(temp, "runtime.json"), EMAIL_ASSET_STORE_PATH: path.join(temp, "assets.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = `http://127.0.0.1:${port}`;
let uploadedUrl = "";
try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const capacity = await (await fetch(`${base}/api/capacity`)).json();
  assert.equal(capacity.pc, 100); assert.equal(capacity.mobile, 100);
  const prepared = await (await fetch(`${base}/api/keyword-collection/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyword: "board games", direction: "buyer" }) })).json();
  assert.equal(prepared.mode, "keyword"); assert.match(prepared.searchUrl, /keyword=board%20games/);
  const countryBusiness = await (await fetch(`${base}/api/country-business-collection/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ country: "Poland", businessScope: "board games, books, paper packaging", direction: "buyer" }) })).json();
  assert.equal(countryBusiness.mode, "country_business");
  assert.equal(countryBusiness.country, "Poland");
  assert.deepEqual(countryBusiness.businessKeywords, ["board games", "books", "paper packaging"]);
  assert.equal(countryBusiness.filter.match, "country_alias_or_visible_country_cell");
  const upload = await (await fetch(`${base}/api/email-assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "pixel.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }) })).json();
  assert.match(upload.asset.id, /^asset_/); assert.match(upload.asset.url, /^\/assets\/uploads\//);
  uploadedUrl = upload.asset.url;
  console.log(JSON.stringify({ ok: true, check: "feature-integration-unit", capacity: capacity.simultaneousOnlineUsers }));
} finally {
  child.kill(); await fs.rm(temp, { recursive: true, force: true });
  if (uploadedUrl) await fs.rm(path.join(root, "public", uploadedUrl.replace(/^\//, "")), { force: true });
}
