import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { countryBusinessCollectionManifest, countryBusinessDiscoveryArtifact, normalizeBusinessKeywords } from "../app/keyword-collection.mjs";

const manifest = countryBusinessCollectionManifest({ country: process.argv[2], businessKeywords: process.argv[3], direction: process.argv[4] });
const { country, businessKeywords, businessQuery, direction } = manifest;
const pageNumber = Number.parseInt(process.argv[5] || "1", 10);
const outputDir = process.argv[6] || path.join("outputs", `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_country_business_discovery`);
const excludeKeywords = normalizeBusinessKeywords(process.argv[7]);
if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("Page must be a positive integer");

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH
  || "C:\\Users\\18395\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright";
const { chromium } = require(playwrightPath);
const browser = await chromium.connectOverCDP(process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9223");
const countryAliases = new Set([
  country.toLowerCase(),
  country.toLowerCase() === "poland" || country === "波兰" ? "polska" : "",
  country.toLowerCase() === "poland" || country === "波兰" ? "波兰" : "",
  country.toLowerCase() === "poland" || country === "波兰" ? "pl" : "",
  country === "波兰" ? "poland" : "",
].filter(Boolean));

async function resetPageState(page) {
  const overlaySelector = ".ant-drawer-content:visible, .ant-modal:visible, .global-marketing-modal:visible";
  const blockingSelector = ".ant-drawer-mask:visible, .ant-modal-mask:visible, .global-marketing-modal:visible";
  for (let attempt = 0; attempt < 4 && await page.locator(blockingSelector).count(); attempt += 1) {
    await page.locator(overlaySelector).evaluateAll((roots) => {
      const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight));
      for (const root of roots.reverse()) {
        const controls = [...root.querySelectorAll(".ant-drawer-close, .ant-modal-close, button, [role=button]")];
        const control = controls.find((element) => visible(element) && element.matches(".ant-drawer-close, .ant-modal-close"))
          || controls.find((element) => visible(element) && /^(?:取消|关闭|跳过)$/.test((element.textContent || "").trim()));
        control?.click();
      }
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
  if (await page.locator(blockingSelector).count()) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => ["首页", "海关数据", "全球搜索"]
      .some((label) => (document.body?.innerText || "").includes(label)), undefined, { timeout: 30_000 });
  }
  if (await page.locator(blockingSelector).count()) {
    throw new Error("NetEase page reset failed after in-page cleanup and one session-preserving reload");
  }
}

try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /waimao\.office\.163\.com/.test(candidate.url()));
  if (!page) throw new Error("NetEase page not found");
  await resetPageState(page);
  const route = direction === "supplier" ? "supplierSearch" : "globalSearch";
  if (!new RegExp(`page=${route}`).test(page.url())) {
    await page.locator(`a[href=\"/#wmData?page=${route}\"]:visible`).first().click();
    await page.waitForTimeout(1_200);
  }
  const keywordTab = page.getByRole("tab", { name: "按关键词", exact: true }).first();
  await keywordTab.waitFor({ timeout: 30_000 });
  if (await keywordTab.getAttribute("aria-selected") !== "true") await keywordTab.click();
  const input = page.locator('input[placeholder*="产品描述"]:visible, input[placeholder*="公司描述"]:visible').first();
  await input.waitFor({ timeout: 30_000 });
  const searchButton = page.getByRole("button", { name: "搜索", exact: true });
  const initialCountrySelect = page.locator('[class*="countrySelectStyle"]:visible').first();
  if (!(await initialCountrySelect.count())) {
    await input.fill(businessQuery);
    if (await searchButton.count()) await searchButton.first().click();
    else await input.press("Enter");
    await page.locator('[class*="countrySelectStyle"]:visible').first().waitFor({ timeout: 30_000 });
  }
  // Switching search modes resets filters, so apply the country afterwards.
  const countrySelect = page.locator('[class*="countrySelectStyle"]:visible').first();
  const countryLabel = country === "Poland" ? "波兰" : country;
  if (!(await countrySelect.innerText()).includes(countryLabel)) {
    const countryModal = page.locator('.ant-modal:visible').first();
    if (!(await countryModal.count())) await countrySelect.click();
    await countryModal.waitFor({ timeout: 30_000 });
    const countrySearch = countryModal.locator('input.ant-input:visible').first();
    await countrySearch.fill(countryLabel);
    const countryItem = countryModal.locator('[class*="countrySelectModal-module--item--"]:visible').filter({ hasText: countryLabel }).first();
    if (!String(await countryItem.getAttribute("class")).includes("item-select")) await countryItem.click();
    await countryModal.getByRole("button", { name: "确认", exact: true }).click();
    await page.waitForTimeout(500);
  }
  if (!(await countrySelect.innerText()).includes(countryLabel)) throw new Error(`Country filter was not applied: ${country}`);
  const previousRows = await page.locator("table:visible tbody").first().innerText().catch(() => "");
  await input.fill(businessQuery);
  if (await searchButton.count()) await searchButton.first().click();
  else await input.press("Enter");
  await page.waitForFunction((previous) => {
    const body = [...document.querySelectorAll("table")].find((table) => table.offsetWidth || table.offsetHeight)?.querySelector("tbody")?.innerText || "";
    return body && body !== previous;
  }, previousRows, { timeout: 30_000 }).catch(() => {});
  if (pageNumber > 1) {
    const firstDataRow = page.locator('table:visible tbody tr').filter({ has: page.locator('button:has-text("深挖联系人")') }).first();
    const previousRow = await firstDataRow.innerText().catch(() => "");
    const jumper = page.locator(".ant-pagination-options-quick-jumper input:visible");
    await jumper.fill(String(pageNumber));
    await jumper.press("Enter");
    await page.waitForFunction(({ expectedPage, previousRow }) => {
      const active = [...document.querySelectorAll('.ant-pagination-item-active')].find((item) => item.offsetWidth || item.offsetHeight);
      const row = [...document.querySelectorAll('table tbody tr')].find((candidate) => (candidate.offsetWidth || candidate.offsetHeight) && candidate.innerText.includes('深挖联系人'));
      return active?.innerText.trim() === String(expectedPage) && row?.innerText.trim() && row.innerText.trim() !== previousRow.trim();
    }, { expectedPage: pageNumber, previousRow }, { timeout: 30_000 });
  }
  await page.waitForFunction(() => [...document.querySelectorAll("table")]
    .some((table) => (table.offsetWidth || table.offsetHeight) && table.querySelectorAll("tr[data-row-key], tbody tr").length > 0), undefined, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const state = await page.evaluate(({ expectedKeyword, expectedPage, expectedDirection, expectedCountry, aliases }) => {
    const text = document.body?.innerText || "";
    const visible = (element) => element && (element.offsetWidth || element.offsetHeight);
    const table = [...document.querySelectorAll("table")].filter((candidate) => visible(candidate))
      .sort((a, b) => b.querySelectorAll("tr[data-row-key], tbody tr").length - a.querySelectorAll("tr[data-row-key], tbody tr").length)
      .find((candidate) => [...candidate.querySelectorAll("tr[data-row-key], tbody tr")].some((row) => row.cells.length > 1));
    const rows = table ? [...table.querySelectorAll("tr[data-row-key], tbody tr")].filter((row) => row.cells.length > 1) : [];
    const countryAliases = new Set(aliases);
    const records = rows.map((row, index) => {
      const cells = [...row.cells].map((cell) => cell.innerText.trim()).filter(Boolean);
      const lines = cells.flatMap((cell) => cell.split(/\n+/).map((line) => line.trim()).filter(Boolean));
      const country = lines.find((line) => countryAliases.has(line.toLowerCase())) || "";
      const company = lines.find((line) => !countryAliases.has(line.toLowerCase()) && !/^[A-Z]$/.test(line)
        && !/^https?:/i.test(line) && !/^(?:行业|主营产品|分析)[:：]?/.test(line)) || "";
      return { page: expectedPage, row: index + 1, rowKey: row.getAttribute("data-row-key") || "", keyword: expectedKeyword, direction: expectedDirection, company, country, cells };
    }).filter((record) => record.company && record.country);
    return {
      url: location.href,
      resultTotal: Number((text.match(/为您找到\s*([0-9,]+)\s*个结果/) || [])[1]?.replaceAll(",", "") || 0),
      safety: {
        captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some(visible),
        rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
        accountError: /权限不足|暂无权限|无权访问|账号异常|登录已失效|重新登录/.test(text),
      },
      records,
      sampleCells: rows.slice(0, 3).map((row) => [...row.cells].map((cell) => cell.innerText.trim()).filter(Boolean)),
      visibleRows: rows.length,
      country: expectedCountry,
    };
  }, { expectedKeyword: businessQuery, expectedPage: pageNumber, expectedDirection: direction, expectedCountry: country, aliases: [...countryAliases] });
  if (state.safety.captcha || state.safety.rateLimited || state.safety.accountError) throw new Error(`Safety boundary: ${JSON.stringify(state.safety)}`);
  if (!state.records.length) throw new Error(`No visible ${country} rows for business query: ${businessQuery}; diagnostics=${JSON.stringify({ url: state.url, visibleRows: state.visibleRows, resultTotal: state.resultTotal, sampleCells: state.sampleCells })}`);
  const snapshot = countryBusinessDiscoveryArtifact({ ...manifest, excludeKeywords, pageNumber, url: state.url, resultTotal: state.resultTotal, sourceRows: state.visibleRows, safety: state.safety, records: state.records });
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `netease_country_business_page_${String(pageNumber).padStart(3, "0")}.json`);
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, country, businessKeywords, direction, resultTotal: state.resultTotal, visibleRows: state.visibleRows, matchedRows: state.records.length, safety: state.safety }, null, 2));
} finally {
  await browser.close();
}
