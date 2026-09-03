import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const hsCode = String(process.argv[2] || "").trim();
const pageNumber = Number.parseInt(process.argv[3] || "", 10);
const outputDir = process.argv[4] || path.join("outputs", `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_hscode_${hsCode}_discovery_checkpoint`);
if (!/^\d{6,10}$/.test(hsCode)) throw new Error("Usage: netease-hscode-discovery.mjs <hscode> <page> [output-dir]");
if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("Page must be a positive integer");

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH
  || "C:\\Users\\18395\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright";
const { chromium } = require(playwrightPath);
const browser = await chromium.connectOverCDP(process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9223");

try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /waimao\.office\.163\.com/.test(candidate.url()));
  if (!page) throw new Error("NetEase page not found");
  if (await page.locator('.ant-drawer-mask:visible').count()) {
    await page.keyboard.press("Escape");
    await page.locator('.ant-drawer-mask:visible').first().waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }
  if (!/page=customs/.test(page.url())) {
    await page.locator('a[href="/#wmData?page=customs"]:visible').first().click();
    await page.waitForTimeout(1_200);
  }

  const hsTab = page.getByRole("tab", { name: "相关HSCode", exact: true });
  if ((await hsTab.getAttribute("aria-selected")) !== "true") {
    await hsTab.click();
  }
  const hsInput = page.locator('input[placeholder="请输入HSCode"]:visible');
  await hsInput.waitFor({ timeout: 30_000 });
  if ((await hsInput.inputValue()).trim() !== hsCode) {
    await hsInput.fill(hsCode);
    await hsInput.press("Enter");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.waitForFunction((expectedHsCode) => {
      const input = [...document.querySelectorAll("input")]
        .find((candidate) => candidate.placeholder === "请输入HSCode" && (candidate.offsetWidth || candidate.offsetHeight));
      return input?.value === expectedHsCode && /为您找到\s*[0-9,]+\s*个结果/.test(document.body?.innerText || "");
    }, hsCode);
  }

  const jumper = page.locator(".ant-pagination-options-quick-jumper input:visible");
  await jumper.fill(String(pageNumber));
  await jumper.press("Enter");
  await page.waitForFunction((expectedPage) => [...document.querySelectorAll(".ant-pagination")]
    .filter((pagination) => (pagination.offsetWidth || pagination.offsetHeight) && pagination.innerText.includes("为您找到"))
    .some((pagination) => pagination.querySelector(".ant-pagination-item-active")?.getAttribute("title") === String(expectedPage)), pageNumber);
  await page.waitForFunction(() => [...document.querySelectorAll("table")]
    .some((table) => {
      if (!(table.offsetWidth || table.offsetHeight)) return false;
      const rows = [...table.querySelectorAll('tr[data-row-key]')];
      return rows.length === 20 && rows.every((row) => row.cells[3]?.innerText.trim()
        && row.cells[4]?.innerText.trim() && row.cells[5]?.innerText.trim() && row.cells[6]?.innerText.trim());
    }));
  await page.waitForTimeout(800);

  const state = await page.evaluate((expectedPage) => ({
    url: location.href,
    activePage: Number([...document.querySelectorAll(".ant-pagination")]
      .filter((pagination) => (pagination.offsetWidth || pagination.offsetHeight) && pagination.innerText.includes("为您找到"))
      .find((pagination) => pagination.querySelector(".ant-pagination-item-active"))
      ?.querySelector(".ant-pagination-item-active")?.getAttribute("title")),
    resultTotal: Number((document.body?.innerText || "").match(/为您找到\s*([0-9,]+)\s*个结果/)?.[1]?.replaceAll(",", "")),
    safety: {
      captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(document.body?.innerText || "") || [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some((el) => el.offsetWidth || el.offsetHeight),
      rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(document.body?.innerText || ""),
      accountError: /权限不足|暂无权限|无权访问|账号异常|登录已失效|重新登录/.test(document.body?.innerText || ""),
    },
    records: (() => {
      const table = [...document.querySelectorAll("table")]
        .find((candidate) => (candidate.offsetWidth || candidate.offsetHeight) && candidate.querySelectorAll('tr[data-row-key]').length === 20);
      return [...table.querySelectorAll('tr[data-row-key]')].map((row, index) => {
        const cells = [...row.cells].map((cell) => cell.innerText.trim());
        const info = cells[3].split("\n").map((value) => value.trim()).filter(Boolean);
        const valueAfter = (label) => {
          const position = info.indexOf(label);
          return position >= 0 ? info[position + 1] || "" : "";
        };
        return {
          page: expectedPage,
          row: index + 1,
          rowKey: row.getAttribute("data-row-key") || "",
          company: info[0] || "",
          country: info[2] || "",
          hasContact: info.includes("联系人"),
          hsCode: valueAfter("相关HSCode："),
          hsCodeDescription: valueAfter("HSCode描述："),
          transactions: cells[4].split("\n")[0] || "",
          amountUsd: cells[5].split("\n")[0] || "",
          latestTradeDate: cells[6].split("\n")[0] || "",
        };
      });
    })(),
  }), pageNumber);

  if (state.activePage !== pageNumber || state.records.length !== 20) {
    throw new Error(`Page ${pageNumber} did not render 20 rows`);
  }
  if (state.safety.captcha || state.safety.rateLimited || state.safety.accountError) {
    throw new Error(`Safety boundary: ${JSON.stringify(state.safety)}`);
  }

  const snapshot = {
    schemaVersion: 1,
    kind: "netease-customs-discovery",
    query: hsCode,
    normalizedHsCode: hsCode,
    capturedAt: new Date().toISOString(),
    dynamicSnapshot: true,
    pagination: { pageNumber, pageTotal: 500, visibleRows: state.records.length },
    source: {
      platform: "网易外贸通",
      page: "海关数据/相关HSCode/采购商",
      url: state.url,
      query: hsCode,
      resultTotal: state.resultTotal,
      pageTotal: 500,
      pageNumber,
      visibleRows: state.records.length,
    },
    safety: { ...state.safety, hiddenApiUsed: false, deepMiningUsed: false },
    records: state.records,
  };
  const outputPath = path.join(outputDir, `netease_customs_page_${String(pageNumber).padStart(3, "0")}.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    outputPath,
    activePage: state.activePage,
    resultTotal: state.resultTotal,
    visibleRows: state.records.length,
    withContacts: state.records.filter((record) => record.hasContact).length,
    safety: state.safety,
  }, null, 2));
} finally {
  await browser.close();
}
