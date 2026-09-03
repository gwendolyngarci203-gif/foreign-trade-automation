import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "prospect-mailbox-export-"));
const mailboxPath = path.join(temp, "mailboxes.json");
await fs.writeFile(mailboxPath, JSON.stringify({ version: 1, accounts: [], messages: [
  { id: "buyer-1", date: "2026-08-29T10:00:00Z", account: "maggie1@dakingscc.cc", from: { name: "Buyer", address: "buyer@example.com" }, to: ["maggie1@dakingscc.cc"], subject: "Re: catalog", bodyText: "Full buyer reply body", snippet: "Full buyer reply body", attachments: [{ filename: "brief.pdf" }], unread: true },
  { id: "internal-1", date: "2026-08-29T09:00:00Z", account: "maggie1@dakingscc.cc", from: { name: "Mailer Daemon", address: "postmaster@dakingscc.cc" }, subject: "Delivery failed", bodyText: "Internal notice", snippet: "Internal notice", unread: true },
] }), "utf8");
const port = 4201;
const child = spawn(process.execPath, [path.join(root, "server.mjs")], { cwd: root, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), MAILBOX_STORE_PATH: mailboxPath }, stdio: ["ignore", "pipe", "pipe"] });
const base = `http://127.0.0.1:${port}`;
try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const response = await fetch(`${base}/api/mailbox/export-replies?ids=buyer-1,internal-1&limit=2`);
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.match(csv, /Full buyer reply body/);
  assert.match(csv, /brief\.pdf/);
  assert.match(csv, /message_json/);
  assert.doesNotMatch(csv, /Internal notice/);
  console.log(JSON.stringify({ ok: true, check: "mailbox-export-unit" }));
} finally {
  child.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
