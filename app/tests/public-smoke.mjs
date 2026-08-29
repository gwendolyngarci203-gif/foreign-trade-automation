import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "foreign-trade-toolkit-"));
const port = 4197;
const store = (name) => path.join(temp, `${name}.json`);
const child = spawn(process.execPath, [path.join(root, "app/server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    SOURCE_PATH: path.join(root, "examples/sample-source.json"),
    CAMPAIGN_PATH: store("campaigns"),
    VALIDATION_PATH: store("validation"),
    SUPPRESSION_PATH: store("suppressions"),
    OPERATIONS_PATH: store("operations"),
    CONTACT_COLLECTION_PATH: store("contact-collection"),
    PIPELINE_PATH: store("pipeline"),
    OUTBOX_PATH: store("outbox"),
    RUNTIME_STATE_PATH: store("runtime-state"),
    SENDER_PROFILE_PATH: path.join(root, "app/data/sender-profile.json"),
    SENDER_ACCOUNTS_PATH: store("sender-accounts"),
    MAILBOX_STORE_PATH: store("mailboxes"),
    MAILBOX_REPLY_STORE_PATH: store("mailbox-replies"),
    LOCAL_BACKUP_DIR: path.join(temp, "backups"),
    EMAIL_SENDING_ENABLED: "false",
  },
  stdio: "ignore",
});

try {
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.ok, true);
  assert.equal(health.delivery.enabled, false);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Foreign Trade Automation Toolkit/);
  console.log("public smoke passed");
} finally {
  child.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
