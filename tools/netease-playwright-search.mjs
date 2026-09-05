import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const playwrightModule = process.env.PLAYWRIGHT_MODULE
  || "C:\\Users\\18395\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright";
const { chromium } = require(playwrightModule);

const endpoint = process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9223";
const companyName = process.argv.slice(2).join(" ").trim();
if (!companyName) throw new Error("Company name is required");

const browser = await chromium.connectOverCDP(endpoint);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const inspected = [];
  for (const page of pages) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return {
        globalSearch: text.includes("全球搜索"),
        topNavigation: ["首页", "海关数据", "全球搜索"].some((label) => text.includes(label)),
        companyTab: [...document.querySelectorAll('[role="tab"]')].some((el) => (el.innerText || "").trim() === "按公司"),
        companyInput: [...document.querySelectorAll('input[placeholder="请输入公司名称"]')]
          .some((el) => el.offsetWidth || el.offsetHeight),
        captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some(el => el.offsetWidth || el.offsetHeight),
        rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
        accountError: /权限不足|暂无权限|无权访问|联系(?:相应)?管理员|账号异常|登录已失效|重新登录/.test(text),
      };
    }).catch(() => null);
    if (state) inspected.push({ page, state, score: Number(state.globalSearch) * 10 + Number(state.topNavigation) * 10 + Number(state.companyTab) * 5 + Number(state.companyInput) * 20 });
  }
  const candidates = inspected
    .filter(({ state }) => state.globalSearch && state.topNavigation && state.companyTab)
    .filter(({ state }) => !state.captcha && !state.rateLimited && !state.accountError)
    .sort((left, right) => right.score - left.score);
  if (!candidates.length) throw new Error("No fixed-element-ready NetEase page found");
  // Runtime startup deduplicates ready pages, but keep selection deterministic
  // here so a leftover duplicate cannot turn every company into a timeout.
  const page = candidates[0].page;

  if (!candidates[0].state.companyInput) {
    await page.locator('a[href="/#wmData?page=globalSearch"]:visible').first().click();
    await page.getByRole("tab", { name: "按公司", exact: true }).waitFor({ timeout: 30_000 });
  }

  const viewport = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  for (const closeButton of await page.locator(".ant-drawer-close:visible").all()) {
    const box = await closeButton.boundingBox().catch(() => null);
    const intersectsViewport = box && box.width > 0 && box.height > 0
      && box.x < viewport.width && box.y < viewport.height
      && box.x + box.width > 0 && box.y + box.height > 0;
    if (!intersectsViewport) {
      console.error("DRAWER_SKIPPED_HIDDEN_OR_OFFSCREEN");
      continue;
    }
    await closeButton.click().catch(() => {});
  }
  const companyTab = page.getByRole("tab", { name: "按公司", exact: true });
  if (await companyTab.getAttribute("aria-selected") !== "true") await companyTab.click();
  const input = page.locator('input[placeholder="请输入公司名称"]:visible');
  await input.waitFor({ timeout: 30_000 });
  await input.fill(companyName);
  const exact = page.locator('input[type="checkbox"]:visible').filter({ has: page.locator("xpath=../..", { hasText: "精确" }) });
  const exactByText = page.locator("label,span").filter({ hasText: /^精确$/ }).locator('input[type="checkbox"]');
  const checkbox = await exactByText.count() ? exactByText.first() : exact.first();
  if (!(await checkbox.isChecked())) await checkbox.check();

  const onboarding = page.locator(".global-marketing-modal:visible").first();
  if (await onboarding.count()) {
    const dismissed = await onboarding.evaluate((root) => {
      const nodes = [...root.querySelectorAll("button,[role=button],a,span,div")]
        .filter((node) => (node.offsetWidth || node.offsetHeight) && (node.textContent || "").trim() === "跳过");
      const target = nodes.at(-1);
      if (!target) return false;
      target.click();
      return true;
    });
    if (!dismissed) throw new Error("Visible NetEase onboarding overlay has no skip control");
    await onboarding.waitFor({ state: "hidden", timeout: 5_000 });
  }

  const normalizeQuery = (value) => value.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return /globalSearch/i.test(response.url())
      && !/\/translate(?:\?|$)/i.test(response.url())
      && request.resourceType() === "xhr";
  }, { timeout: 30_000 }).catch(() => null);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const response = await responsePromise;
  if (!response) throw new Error("No new global-search XHR received after submit");
  await response.finished();
  const requestPayload = response.request().postData() || "";
  const requestPayloadMatches = normalizeQuery(requestPayload).includes(normalizeQuery(companyName));
  const responseBody = await response.json().catch(() => null);
  const responsePage = responseBody?.data?.pageableResult || {};
  const responseNames = Array.isArray(responsePage.data)
    ? responsePage.data.map((item) => String(item.recommendShowName || item.name || "").trim()).filter(Boolean)
    : [];
  const responseTotal = Number(responsePage.total ?? responseBody?.data?.realTotalCount ?? responseNames.length);
  if (process.env.DEBUG_SEARCH_RESPONSE === "1") {
    console.error(JSON.stringify({ url: response.url(), requestPayload, responseBody }, null, 2));
  }
  await page.waitForTimeout(700);
  const renderWaitMatched = await page.waitForFunction(({ names, total }) => {
    const text = document.body?.innerText || "";
    const table = [...document.querySelectorAll("table")]
      .find((candidate) => candidate.querySelector('tr[data-row-key]') && candidate.innerText.includes("一键营销"));
    const signature = table?.innerText || "";
    const normalize = (value) => value.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const returnedNameVisible = names.length > 0 && names.some((name) => normalize(signature).includes(normalize(name)));
    return returnedNameVisible || (total === 0 && text.includes("暂无数据，可尝试去网页搜索最新内容"))
      || /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)|操作频繁|权限不足|账号异常/.test(text);
  }, { names: responseNames, total: responseTotal }, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  const result = await page.evaluate((expected) => {
    const text = document.body?.innerText || "";
    const input = [...document.querySelectorAll("input")].find((el) => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight));
    const exact = [...document.querySelectorAll('input[type="checkbox"]')].find((el) => (el.offsetWidth || el.offsetHeight) && (el.parentElement?.parentElement?.innerText || "").includes("精确"));
    const table = [...document.querySelectorAll("table")]
      .find((candidate) => candidate.querySelector('tr[data-row-key]') && candidate.innerText.includes("一键营销"));
    const count = text.match(/为您找到\s*([0-9+]+)\s*个结果/)?.[1] || "";
    const resultSignature = table?.innerText?.trim() || (text.includes("暂无数据，可尝试去网页搜索最新内容") ? `empty:${count || "0"}` : "");
    return {
      companyName: expected,
      submittedValue: input?.value || "",
      exact: Boolean(exact?.checked),
      resultCount: count,
      resultSignature,
      rendered: Boolean(table) || text.includes("暂无数据，可尝试去网页搜索最新内容"),
      captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some(el => el.offsetWidth || el.offsetHeight),
      rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
      accountError: /权限不足|暂无权限|无权访问|联系(?:相应)?管理员|账号异常|登录已失效|重新登录/.test(text),
    };
  }, companyName);
  const targetList = await (await fetch(`${endpoint}/json/list`)).json().catch(() => []);
  const targetId = targetList.find((target) => target.type === "page" && target.url === page.url())?.id || "";
  if (!targetId) {
    const error = new Error("TARGET_CHANGED: searched page target could not be resolved");
    error.code = "TARGET_CHANGED";
    throw error;
  }
  if (result.submittedValue !== companyName) {
    const error = new Error("SEARCH_STATE_MISMATCH: submitted value changed after search");
    error.code = "SEARCH_STATE_MISMATCH";
    throw error;
  }
  if (!result.exact) {
    const error = new Error("EXACT_MODE_LOST: exact mode was not preserved after search");
    error.code = "EXACT_MODE_LOST";
    throw error;
  }
  if (!result.rendered && !result.captcha && !result.rateLimited && !result.accountError) {
    const error = new Error("RESULT_NOT_READY: global-search response completed without rendered result");
    error.code = "RESULT_NOT_READY";
    throw error;
  }
  console.log(JSON.stringify({
    targetId,
    ...result,
    query: companyName,
    timestamp: new Date().toISOString(),
    responseStatus: response.status(),
    requestMatched: requestPayloadMatches,
    renderWaitMatched,
    responseTotal,
    responseNames,
  }, null, 2));
} finally {
  await browser.close();
}
