import assert from "node:assert/strict";
import fs from "node:fs";

for (const file of ["tools/netease-cdp-client.mjs", "tools/netease-playwright-search.mjs"]) {
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, /验证码\|安全验证\|captcha/, `${file} must not treat company-page reCAPTCHA text as a platform prompt`);
  assert.match(source, /iframe\[src\*="captcha" i\]/, `${file} must still detect a visible CAPTCHA widget`);
  assert.match(source, /\/验证码\|安全验证\/\.test\(text\)/, `${file} must still stop on platform verification text`);
}

const searchSource = fs.readFileSync("tools/netease-playwright-search.mjs", "utf8");
assert.match(searchSource, /state\.companyInput/, "NetEase company search must require its visible company-name input");
assert.match(searchSource, /input\[placeholder=\"请输入公司名称\"\]/, "NetEase company-page guard must use the fixed input selector");

const cdpSource = fs.readFileSync("tools/netease-cdp-client.mjs", "utf8");
assert.match(cdpSource, /globalThis\.WebSocket \|\| require/, "NetEase CDP client must support the server Node runtime without a global WebSocket");
assert.doesNotMatch(cdpSource, /value:\s*el\.value/, "NetEase inspection must not print live input values");
assert.match(cdpSource, /hasValue:\s*Boolean\(el\.value\)/, "NetEase inspection may expose only whether a field is populated");
assert.match(cdpSource, /Visible login form did not become ready within 30 seconds/, "NetEase login must wait for the actual visible form before credential submission");
assert.ok(cdpSource.indexOf("账号/手机号登录") < cdpSource.indexOf("const formDeadline"), "Fresh NetEase profiles must switch from QR login before waiting for account fields");

const runnerSource = fs.readFileSync("tools/run-managed-hscode-plan.mjs", "utf8");
assert.ok(runnerSource.indexOf("registerManagedPlan(plan, service)") < runnerSource.indexOf("await ensureLoggedIn()"), "Managed runner must check its local task budget before touching NetEase");
assert.ok(runnerSource.indexOf('"ensure-business-page"') < runnerSource.indexOf('"login-from-file"'), "Managed runner must recover the business page before attempting credential submission");
assert.match(runnerSource, /\["success", "logged_in"\]\.includes\(result\.status\)/, "Managed runner must accept the login client's documented success status");
assert.ok(runnerSource.lastIndexOf('"ready-target"') > runnerSource.indexOf('"login-from-file"'), "Managed runner must verify fixed business elements after login");
assert.match(runnerSource, /handoff-managed-pipeline\.py/, "Completed managed pages must hand off to the server pipeline");
assert.doesNotMatch(runnerSource, /after\.counts\?\.remaining === 0/, "Managed batches must not wait for a whole page before server handoff");
assert.match(runnerSource, /managed-handoff-state\.json/, "Managed batches must persist idempotent incremental handoff state");
assert.ok(runnerSource.indexOf("const latestHandoff") < runnerSource.indexOf("if (handoffOnly)"), "Managed retries must recover the newest completed queue before starting new page work");

const supervisorSource = fs.readFileSync("tools/netease-contact-supervisor.mjs", "utf8");
assert.match(supervisorSource, /\.codex_work.*netease-supervisor-state\.json/, "Supervisor state must live in the writable runtime directory");
assert.match(runnerSource, /--handoff-only/, "Managed runner must flush completed local work before inventory hold");
assert.match(runnerSource, /item\.fingerprint/, "Managed qualification must consume the suppression API's public fingerprint field");
assert.doesNotMatch(runnerSource, /item\.email \|\| item\.emailHash/, "Managed qualification must not expect suppressed plaintext email from the API");

assert.ok(supervisorSource.indexOf("recordManagedCompletions(before)") < supervisorSource.indexOf("before.counts.remaining === 0"), "Managed recovery must reconcile completed companies before an early complete return");

const discoverySource = fs.readFileSync("tools/netease-hscode-discovery.mjs", "utf8");
assert.match(searchSource, /global-marketing-modal:visible/, "Managed search must detect the known NetEase onboarding overlay");
assert.match(searchSource, /hasMaskGuide-module--skip:visible/, "Managed search must dismiss the onboarding overlay before searching");
assert.match(searchSource, /onboarding\.waitFor\(\{ state: "hidden"/, "Managed search must verify the onboarding overlay is gone");
assert.match(discoverySource, /input\[placeholder="请输入HSCode"\]/, "HSCode discovery must target only the primary exact-match input");
assert.doesNotMatch(discoverySource, /placeholder\^="请输入HSCode"/, "HSCode discovery must not match the document filter input");
assert.match(discoverySource, /pagination\.innerText\.includes\("为您找到"\)/, "HSCode discovery must bind page readiness to the result pagination");
assert.match(discoverySource, /\.ant-pagination-item-active/, "HSCode discovery must verify the active result page");
assert.match(discoverySource, /rows\.every/, "HSCode discovery must wait for complete business columns before freezing a page");

console.log("netease safety detection unit passed");
