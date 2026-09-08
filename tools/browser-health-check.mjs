import { BrowserControlError, cdpEvaluate, withTimeout } from "./browser-control-foundation.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const endpoint = valueOf("--endpoint", process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9224");
const requestedTargetId = valueOf("--target-id", "");
const timeoutMs = Math.max(250, Number(valueOf("--timeout-ms", "5000")) || 5000);
const statePath = valueOf("--state-file", process.env.BROWSER_HEALTH_STATE_PATH || path.join(import.meta.dirname, "..", "browser-runtime", "browser-health-state.json"));
const checkedAt = new Date().toISOString();
const errors = [];
const result = { schemaVersion: 1, checkedAt, overall: "failed", endpoint: {}, target: {}, runtime: {}, dom: {}, pageState: {}, errors };

try {
  const started = Date.now();
  const response = await withTimeout(() => fetch(`${endpoint}/json/list`), { stage: "cdp.endpoint", timeoutMs, code: "CDP_ENDPOINT_ERROR" });
  if (!response.ok) throw new BrowserControlError("CDP_ENDPOINT_ERROR", `HTTP ${response.status}`, { stage: "cdp.endpoint", elapsedMs: Date.now() - started, timeoutMs });
  const pages = (await response.json()).filter((item) => item.type === "page");
  result.endpoint = { status: "healthy", url: endpoint, latencyMs: Date.now() - started, pageCount: pages.length };
  const target = pages.find((item) => item.id === requestedTargetId) || pages.find((item) => /waimao\.office\.163\.com/.test(item.url));
  if (!target) throw new BrowserControlError("TARGET_NOT_FOUND", "No matching page target", { stage: "target.discover", timeoutMs });
  result.target = { status: "healthy", targetId: target.id, url: target.url, title: target.title, stableSamples: 1 };
  const probe = await cdpEvaluate(target, "JSON.stringify({ arithmetic: 1 + 1, title: document.title, href: location.href, readyState: document.readyState, bodyReadable: Boolean(document.body), querySelectorReadable: Boolean(document.querySelector('body')), globalSearch: (document.body?.innerText || '').includes('全球搜索'), login: location.pathname.includes('/login') || (document.body?.innerText || '').includes('邮箱/手机号登录'), captcha: Boolean(document.querySelector('[class*=captcha i],[id*=captcha i],iframe[src*=captcha i]')) })", timeoutMs);
  const values = JSON.parse(probe);
  result.runtime = { status: "healthy", probes: { arithmetic: { ok: values.arithmetic === 2 }, title: { ok: typeof values.title === "string" }, location: { ok: typeof values.href === "string" }, readyState: { ok: Boolean(values.readyState) } } };
  result.dom = { status: values.bodyReadable && values.querySelectorReadable ? "healthy" : "failed", bodyReadable: values.bodyReadable, querySelectorReadable: values.querySelectorReadable };
  result.pageState = { status: values.captcha ? "captcha" : values.login ? "login" : values.globalSearch ? "business" : "unknown", globalSearch: values.globalSearch, abnormalOverlay: values.captcha };
  result.overall = result.runtime.status === "healthy" && result.dom.status === "healthy" && result.pageState.status !== "captcha" ? "healthy" : "degraded";
} catch (error) {
  const normalized = error instanceof BrowserControlError ? error : new BrowserControlError("CDP_ENDPOINT_ERROR", error?.message || String(error), { stage: "health-check", timeoutMs });
  errors.push(normalized.toJSON());
  if (!result.endpoint.status) result.endpoint = { status: normalized.code === "CDP_ENDPOINT_ERROR" ? "failed" : "unknown", url: endpoint };
  result.overall = "degraded";
  result.runtime = { status: ["DOM_EVALUATION_TIMEOUT", "RENDERER_HUNG", "WEBSOCKET_TIMEOUT"].includes(normalized.code) ? "timeout" : "failed" };
}

const previous = await fs.readFile(statePath, "utf8").then(JSON.parse).catch(() => ({}));
const failureCode = result.errors[0]?.code || "";
const state = {
  schemaVersion: 1,
  status: result.overall,
  last_check_time: checkedAt,
  last_success_time: result.overall === "healthy" ? checkedAt : previous.last_success_time || "",
  last_failure_time: result.overall === "healthy" ? previous.last_failure_time || "" : checkedAt,
  failure_code: failureCode,
  recovery_count: Number(previous.recovery_count || 0) + Number(Boolean(previous.status && previous.status !== "healthy" && result.overall === "healthy")),
  targetId: result.target.targetId || "",
  url: result.target.url || "",
};
await fs.mkdir(path.dirname(statePath), { recursive: true });
const temporary = `${statePath}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await fs.rename(temporary, statePath);
result.recoveryState = state;
console.log(JSON.stringify(result, null, 2));
if (result.overall !== "healthy") process.exitCode = 2;
