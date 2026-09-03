import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.env.OPS_BASE_DIR || "/opt/dakings-prospect-ops";
const statePath = `${root}/deploy/runtime-data/netease-login-recovery.json`;
const qrPath = `${root}/.codex_work/server-netease-qr.png`;
const api = process.env.PIPELINE_API_BASE || "http://127.0.0.1:4173";

async function readState() { return JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}")); }
async function writeState(state) { await fs.mkdir(`${root}/deploy/runtime-data`, { recursive: true }); await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }
async function inspect() {
  try {
    const { stdout } = await exec("node", [`${root}/tools/netease-cdp-client.mjs`, "inspect"], { timeout: 45_000, env: { ...process.env, EDGE_CDP_ENDPOINT: "http://127.0.0.1:9224", WS_MODULE: `${root}/browser-runtime/node_modules/ws` } });
    const data = JSON.parse(stdout); return { authenticated: Boolean(data.readyTargetId), connected: true, detail: data };
  } catch (error) { return { authenticated: false, connected: false, error: String(error.stderr || error.message || error).slice(0, 800) }; }
}
async function alert(state, code, title, details, instructions) {
  const key = `${new Date().toISOString().slice(0, 10)}:${code}`;
  if (state.alerts?.[key]) return;
  const response = await fetch(`${api}/api/ops/intervention-alert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, incidentId: key, title, details, instructions }) });
  if (!response.ok) throw new Error(await response.text());
  state.alerts ||= {}; state.alerts[key] = new Date().toISOString();
}
async function refreshQr() {
  const script = `const {chromium}=require('${root}/browser-runtime/node_modules/playwright-core');(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9224');const p=b.contexts().flatMap(c=>c.pages()).find(x=>x.url().includes('waimao.office.163.com'));if(!p)throw Error('NetEase page missing');await p.bringToFront();await p.reload({waitUntil:'domcontentloaded',timeout:30000});await p.waitForTimeout(2000);const media=p.locator('canvas:visible,img:visible');const i=await media.evaluateAll(xs=>xs.findIndex(x=>{const r=x.getBoundingClientRect();return r.width>=140&&r.width<=320&&r.height>=140&&r.height<=320&&Math.abs(r.width-r.height)<20}));if(i<0)throw Error('Fresh QR element not found');await media.nth(i).screenshot({path:'${qrPath}'});await b.close()})().catch(e=>{console.error(e);process.exit(1)})`;
  const encoded = Buffer.from(script).toString("base64");
  await exec("runuser", ["-u", "prospectops", "--", "node", "-e", `eval(Buffer.from('${encoded}','base64').toString())`], { timeout: 90_000 });
}

const state = await readState();
const current = await inspect();
if (current.authenticated) {
  if (state.status === "WAITING_MANUAL_LOGIN") { state.status = "READY"; state.recoveredAt = new Date().toISOString(); }
  state.failures = 0; await writeState(state); process.exit(0);
}
if (state.status !== "WAITING_MANUAL_LOGIN") { state.qrGeneratedAt = ""; state.failures = 0; }
state.status = "WAITING_MANUAL_LOGIN"; state.failures = Number(state.failures || 0) + 1; state.lastCheckedAt = new Date().toISOString();
let qrError = "";
for (let attempt = 1; attempt <= 3 && !state.qrGeneratedAt; attempt++) {
  try { await refreshQr(); state.qrGeneratedAt = new Date().toISOString(); qrError = ""; }
  catch (error) { qrError = String(error.message || error).slice(0, 800); if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500)); }
}
if (!state.qrGeneratedAt && state.failures >= 1) {
  try { await exec("systemctl", ["restart", "dakings-netease-browser.service"], { timeout: 45_000 }); state.browserRestartedAt = new Date().toISOString(); } catch (error) { qrError += `; restart failed: ${String(error.message || error).slice(0, 300)}`; }
  state.failures = 0;
}
try {
  if (state.qrGeneratedAt) await alert(state, "netease_login_required", "网易登录恢复请求：需要扫码", `状态：WAITING_MANUAL_LOGIN；检查时间：${state.lastCheckedAt}；二维码：${qrPath}；二维码已刷新生成，未复用旧二维码。`, "打开最新二维码并扫码；扫码后系统会自动检测会话并恢复采集，无需手工重跑。二维码文件仅保存在服务器。" );
  else if (state.failures >= 3) await alert(state, "netease_login_recovery_failed", "网易登录恢复失败", `状态：WAITING_MANUAL_LOGIN；检查时间：${state.lastCheckedAt}；失败原因：${qrError}；二维码路径：${qrPath}`, "服务器已重启持久化网易浏览器并会自动重试；若仍失败，请确认网易服务可访问。" );
} catch (error) { state.lastAlertError = String(error.message || error).slice(0, 500); }
await writeState(state);
