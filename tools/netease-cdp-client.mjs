import { chmod, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocketClient = globalThis.WebSocket || require(process.env.WS_MODULE || "ws").WebSocket;

const endpoint = process.env.EDGE_CDP_ENDPOINT || "http://127.0.0.1:9223";
const businessUrl = "https://waimao.office.163.com/#wmData?page=globalSearch";

async function targets() {
  const response = await fetch(`${endpoint}/json/list`);
  if (!response.ok) throw new Error(`CDP target listing failed: HTTP ${response.status}`);
  return response.json();
}

async function cdpCall(webSocketDebuggerUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClient(webSocketDebuggerUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP ${method} timed out`));
    }, 15_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`CDP ${method} WebSocket error`));
    });
  });
}

async function evaluate(target, expression, awaitPromise = true) {
  const result = await cdpCall(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: false,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "CDP evaluation failed");
  }
  return result.result?.value;
}

async function replaceFocusedText(ws, text) {
  await cdpCall(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdpCall(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  for (const character of text) {
    await cdpCall(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character, unmodifiedText: character });
    await cdpCall(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: character });
  }
}

async function inspectTarget(target) {
  return evaluate(target, `(() => {
    const text = document.body?.innerText || "";
    const inputs = [...document.querySelectorAll("input")].map((el, index) => ({
      index,
      placeholder: el.placeholder || "",
      type: el.type || "",
      hasValue: Boolean(el.value),
      disabled: Boolean(el.disabled),
    }));
    const checks = {
      globalSearch: text.includes("全球搜索"),
      topNavigation: ["首页", "海关数据", "全球搜索"].some(label => text.includes(label)),
      searchControl: inputs.some(input => /公司|搜索|关键词|请输入/.test(input.placeholder)) || inputs.length > 0,
      captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some(el => el.offsetWidth || el.offsetHeight),
      rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
      accountError: /权限不足|暂无权限|无权访问|联系(?:相应)?管理员|账号异常|登录已失效|重新登录/.test(text),
    };
    const companyInput = inputs.some(input => input.placeholder === "请输入公司名称");
    const companyTab = [...document.querySelectorAll('[role="tab"]')]
      .some(el => (el.innerText || "").trim() === "按公司");
    const searchButton = [...document.querySelectorAll("button")]
      .some(el => (el.innerText || "").trim() === "搜索" && !el.disabled);
    const targetScore = Number(checks.globalSearch) * 10
      + Number(checks.topNavigation) * 10
      + Number(checks.searchControl) * 10
      + Number(companyTab) * 5
      + Number(companyInput) * 3
      + Number(searchButton) * 2;
    return {
      title: document.title,
      checks,
      businessReady: checks.globalSearch && checks.topNavigation && checks.searchControl
        && companyTab && searchButton && !checks.accountError,
      companyTab,
      companyInput,
      searchButton,
      targetScore,
      inputs,
      textSample: text.slice(0, 2500),
    };
  })()`);
}

async function inspectedPages() {
  const inspected = [];
  for (const target of pageTargets) {
    const state = await inspectTarget(target).catch((error) => ({ error: error.message }));
    inspected.push({ target, targetId: target.id, state });
  }
  return inspected;
}

function selectBusinessTarget(inspected) {
  const candidates = inspected
    .filter((item) => item.state?.businessReady)
    .filter((item) => !item.state.checks.captcha && !item.state.checks.rateLimited && !item.state.checks.accountError)
    .sort((left, right) => (right.state.targetScore || 0) - (left.state.targetScore || 0));
  if (!candidates.length) throw new Error("No fixed-element-ready NetEase business page found");
  return candidates[0];
}

const command = process.argv[2] || "inspect";
const allTargets = await targets();
const pageTargets = allTargets.filter((target) => target.type === "page");

if (command === "inspect") {
  const inspected = await inspectedPages();
  let ready;
  try {
    ready = selectBusinessTarget(inspected);
  } catch {
    ready = null;
  }
  console.log(JSON.stringify({ connected: true, readyTargetId: ready?.targetId || "", pages: inspected.map(({ targetId, state }) => ({ targetId, state })) }, null, 2));
  process.exitCode = ready && !ready.state.checks.captcha && !ready.state.checks.rateLimited && !ready.state.checks.accountError ? 0 : 2;
} else if (command === "ready-target") {
  const ready = selectBusinessTarget(await inspectedPages());
  console.log(JSON.stringify({ targetId: ready.targetId, state: ready.state }, null, 2));
} else if (command === "reload-ready") {
  const ready = selectBusinessTarget(await inspectedPages());
  await cdpCall(ready.target.webSocketDebuggerUrl, "Page.reload", { ignoreCache: false });
  // NetEase may finish restoring the fixed business shell well after the
  // document reload event. Keep recovery within the documented 90-second
  // readiness budget instead of treating a slow server page as a hard fault.
  const deadline = Date.now() + 90_000;
  let refreshed;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const state = await inspectTarget(ready.target).catch(() => null);
    if (state?.businessReady && !state.checks.captcha && !state.checks.rateLimited && !state.checks.accountError) {
      refreshed = state;
      break;
    }
  }
  if (!refreshed) throw new Error("NetEase fixed elements did not become ready within 90 seconds after reload");
  console.log(JSON.stringify({ targetId: ready.targetId, reloaded: true, state: refreshed }, null, 2));
} else if (command === "ensure-business-page") {
  const inspected = await inspectedPages();
  let ready;
  try {
    ready = selectBusinessTarget(inspected);
  } catch {
    ready = null;
  }
  if (ready) {
    console.log(JSON.stringify({ targetId: ready.targetId, navigated: false, state: ready.state }, null, 2));
  } else {
    const candidate = [...inspected].sort((left, right) => {
      const titlePreference = Number(/网易|NetEase/i.test(right.state?.title || ""))
        - Number(/网易|NetEase/i.test(left.state?.title || ""));
      if (titlePreference) return titlePreference;
      return (right.state?.targetScore || 0) - (left.state?.targetScore || 0);
    })[0];
    if (!candidate) throw new Error("No Edge page target is available for NetEase recovery");
    const navigation = await cdpCall(candidate.target.webSocketDebuggerUrl, "Page.navigate", { url: businessUrl });
    if (navigation?.errorText) throw new Error(`NetEase navigation failed: ${navigation.errorText}`);
    const deadline = Date.now() + 90_000;
    let recovered;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const state = await inspectTarget(candidate.target).catch(() => null);
      if (state?.checks?.captcha || state?.checks?.rateLimited || state?.checks?.accountError) {
        throw new Error("NetEase recovery page exposed a platform safety or account signal");
      }
      if (state?.businessReady) {
        recovered = state;
        break;
      }
    }
    if (!recovered) throw new Error("NetEase fixed elements did not become ready within 90 seconds after navigation");
    console.log(JSON.stringify({ targetId: candidate.targetId, navigated: true, state: recovered }, null, 2));
  }
} else if (command === "dedupe-ready") {
  const inspected = await inspectedPages();
  const candidates = inspected
    .filter((item) => item.state?.businessReady)
    .filter((item) => !item.state.checks.captcha && !item.state.checks.rateLimited && !item.state.checks.accountError)
    .sort((left, right) => (right.state.targetScore || 0) - (left.state.targetScore || 0));
  if (!candidates.length) throw new Error("No fixed-element-ready NetEase page found for deduplication");
  const keep = candidates[0];
  const closed = [];
  for (const duplicate of candidates.slice(1)) {
    await cdpCall(duplicate.target.webSocketDebuggerUrl, "Page.close").catch(() => null);
    closed.push(duplicate.targetId);
  }
  console.log(JSON.stringify({ keptTargetId: keep.targetId, closedTargetIds: closed }, null, 2));
} else if (command === "reload-target") {
  const targetId = process.argv[3];
  const target = pageTargets.find((item) => item.id === targetId);
  if (!target) throw new Error(`Page target not found: ${targetId}`);
  await cdpCall(target.webSocketDebuggerUrl, "Page.reload", { ignoreCache: false });
  console.log(JSON.stringify({ targetId, reloaded: true }, null, 2));
} else if (command === "eval") {
  const targetId = process.argv[3];
  const expression = process.argv.slice(4).join(" ");
  const target = pageTargets.find((item) => item.id === targetId);
  if (!target) throw new Error(`Page target not found: ${targetId}`);
  console.log(JSON.stringify(await evaluate(target, expression), null, 2));
} else if (command === "call") {
  const targetId = process.argv[3];
  const method = process.argv[4];
  const params = JSON.parse(process.argv.slice(5).join(" ") || "{}");
  const target = pageTargets.find((item) => item.id === targetId);
  if (!target) throw new Error(`Page target not found: ${targetId}`);
  console.log(JSON.stringify(await cdpCall(target.webSocketDebuggerUrl, method, params), null, 2));
} else if (command === "login-from-file") {
  const credentialPath = process.argv[3] || "网易外贸通.txt";
  const lines = (await readFile(credentialPath, "utf8"))
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const valueAfterLabel = (pattern) => {
    const line = lines.find((item) => pattern.test(item));
    return line?.replace(/^[^:：]*[:：]\s*/, "").trim() || "";
  };
  const account = valueAfterLabel(/账号|用户名|user|email/i);
  const password = valueAfterLabel(/密码|pass/i);
  if (!account || !password) throw new Error("Credential file must contain labeled account and password lines");

  const target = pageTargets.find((item) => item.url?.startsWith("https://waimao.office.163.com/login/"));
  if (!target) throw new Error("NetEase login page is not open in the isolated Edge profile");
  const ws = target.webSocketDebuggerUrl;
  const accountMode = await evaluate(target, `(() => {
    const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight));
    const inputs = [...document.querySelectorAll("input")];
    if (inputs.some(el => el.placeholder === "网易企业邮箱账号" && visible(el))
      && inputs.some(el => el.placeholder === "请输入密码" && visible(el))) return { ready: true };
    if (inputs.some(visible)) return { loginForm: true };
    const control = [...document.querySelectorAll('[data-test-id="login-method-switch"]')].find(visible)
      || [...document.querySelectorAll("button,a,div,span")]
        .find(el => ["账号/手机号登录", "邮箱/手机号登录"].includes((el.innerText || "").replace(/\\s+/g, "")) && visible(el));
    if (!control) return null;
    const rect = control.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.25 };
  })()`);
  if (!accountMode) throw new Error("Visible account-login switch was not found");
  if (!accountMode.ready && !accountMode.loginForm) {
    await cdpCall(ws, "Page.bringToFront");
    await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mousePressed", ...accountMode, button: "left", clickCount: 1 });
    await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", ...accountMode, button: "left", clickCount: 1 });
  }
  const formDeadline = Date.now() + 30_000;
  let formReady = false;
  let emailModeClicked = false;
  while (Date.now() < formDeadline) {
    const formState = await evaluate(target, `(() => {
      const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight));
      const inputs = [...document.querySelectorAll("input")];
      if (inputs.some(el => el.placeholder === "网易企业邮箱账号" && visible(el))
        && inputs.some(el => el.placeholder === "请输入密码" && visible(el))) return { ready: true };
      const emailTab = [...document.querySelectorAll('[class*="tabTxt"]')]
        .find(el => (el.innerText || "").trim() === "邮箱" && visible(el));
      if (!emailTab) return null;
      const rect = emailTab.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    formReady = Boolean(formState?.ready);
    if (formReady) break;
    if (formState && !emailModeClicked) {
      await cdpCall(ws, "Page.bringToFront");
      await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mousePressed", ...formState, button: "left", clickCount: 1 });
      await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", ...formState, button: "left", clickCount: 1 });
      emailModeClicked = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!formReady) throw new Error("Visible login form did not become ready within 30 seconds");
  const focusInput = async (placeholder) => evaluate(target, `(() => {
    const input = [...document.querySelectorAll("input")]
      .find(el => el.placeholder === ${JSON.stringify(placeholder)} && (el.offsetWidth || el.offsetHeight));
    if (!input) throw new Error("Visible login input missing");
    input.focus();
    input.select();
    return true;
  })()`);
  await focusInput("网易企业邮箱账号");
  await cdpCall(ws, "Input.insertText", { text: account });
  await focusInput("请输入密码");
  await cdpCall(ws, "Input.insertText", { text: password });

  const prepared = await evaluate(target, `(() => {
    const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight));
    const accountInput = [...document.querySelectorAll("input")]
      .find(el => el.placeholder === "网易企业邮箱账号" && visible(el));
    const passwordInput = [...document.querySelectorAll("input")]
      .find(el => el.placeholder === "请输入密码" && visible(el));
    const protocol = document.querySelector('[data-test-id="bt-protocol-checked"]');
    if (!accountInput || !passwordInput || !protocol) throw new Error("Login controls are incomplete");
    const checked = /checked|selected|active/.test(protocol.className);
    const rect = protocol.getBoundingClientRect();
    return { accountLength: accountInput.value.length, passwordLength: passwordInput.value.length, checked, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (prepared.accountLength !== account.length || prepared.passwordLength !== password.length) {
    throw new Error("Credential fields did not accept the complete values");
  }
  if (!prepared.checked) {
    await cdpCall(ws, "Page.bringToFront");
    await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: prepared.x, y: prepared.y, button: "left", clickCount: 1 });
    await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x: prepared.x, y: prepared.y, button: "left", clickCount: 1 });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const protocolChecked = await evaluate(target, `(() => {
    const protocol = document.querySelector('[data-test-id="bt-protocol-checked"]');
    return Boolean(protocol && /checked|selected|active/.test(protocol.className));
  })()`);
  if (!protocolChecked) throw new Error("Service agreement checkbox did not become selected");

  await evaluate(target, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find(el => (el.innerText || "").replace(/\\s+/g, "") === "登录" && !el.disabled && (el.offsetWidth || el.offsetHeight));
    if (!button) throw new Error("Visible login button missing");
    button.click();
    return true;
  })()`);

  const deadline = Date.now() + 90_000;
  let result = { status: "timeout" };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    result = await evaluate(target, `(() => {
      const text = document.body?.innerText || "";
      const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight));
      const captcha = [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i], iframe[src*="yidun" i], [class*="yidun" i]')].some(visible);
      const mfa = [...document.querySelectorAll('input[placeholder="请输入6位验证码"]')].some(visible);
      const credentialError = /账号或密码错误|密码错误|账号不存在/.test(text);
      const accountError = /权限不足|账号异常|登录已失效/.test(text);
      const loggedIn = !location.pathname.startsWith("/login")
        && ["首页", "海关数据", "全球搜索"].some(label => text.includes(label));
      return {
        status: captcha ? "captcha" : mfa ? "mfa" : credentialError ? "credential_error" : accountError ? "account_error" : loggedIn ? "logged_in" : "waiting",
        url: location.href,
      };
    })()`);
    if (result.status !== "waiting") break;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "logged_in") process.exitCode = ["captcha", "mfa"].includes(result.status) ? 3 : 2;
} else if (command === "aliyun-login-from-file") {
  const credentialPath = process.argv[3] || "管理域名和邮箱的阿里云账号密码.txt";
  const lines = (await readFile(credentialPath, "utf8"))
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const valueAfterLabel = (pattern) => {
    const line = lines.find((item) => pattern.test(item));
    return line?.replace(/^[^:：]*[:：]\s*/, "").trim() || "";
  };
  const account = valueAfterLabel(/账号|用户名|user|email/i);
  const password = valueAfterLabel(/密码|pass/i);
  if (!account || !password) throw new Error("Credential file must contain labeled account and password lines");

  const target = pageTargets.find((item) => item.url?.startsWith("https://account.aliyun.com/login/"));
  if (!target) throw new Error("Aliyun account login page is not open in the isolated Edge profile");
  const ws = target.webSocketDebuggerUrl;
  const { frameTree } = await cdpCall(ws, "Page.getFrameTree");
  const findFrame = (node) => node.frame.url.startsWith("https://passport.aliyun.com/havanaone/login/")
    && node.frame.url.includes("appEntrance=aliyun_pc_pwd")
    ? node.frame
    : node.childFrames?.map(findFrame).find(Boolean);
  const loginFrame = findFrame(frameTree);
  if (!loginFrame) throw new Error("Aliyun password login iframe is not available");
  const { executionContextId } = await cdpCall(ws, "Page.createIsolatedWorld", {
    frameId: loginFrame.id,
    worldName: "codex-aliyun-login",
  });
  const evaluateInFrame = async (expression, userGesture = false) => {
    const result = await cdpCall(ws, "Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Aliyun iframe evaluation failed");
    return result.result?.value;
  };
  const focusInput = async (type) => evaluateInFrame(`(() => {
    const input = [...document.querySelectorAll("input")]
      .find(el => el.type === ${JSON.stringify(type)} && (el.offsetWidth || el.offsetHeight));
    if (!input) throw new Error("Visible ${type} login input missing");
    input.focus();
    input.select();
    return true;
  })()`);
  await focusInput("text");
  await replaceFocusedText(ws, account);
  await focusInput("password");
  await replaceFocusedText(ws, password);

  const prepared = await evaluateInFrame(`(() => {
    const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight));
    const accountInput = [...document.querySelectorAll("input")].find(el => el.type === "text" && visible(el));
    const passwordInput = [...document.querySelectorAll("input")].find(el => el.type === "password" && visible(el));
    return { accountLength: accountInput?.value.length || 0, passwordLength: passwordInput?.value.length || 0 };
  })()`);
  if (prepared.accountLength !== account.length || prepared.passwordLength !== password.length) {
    throw new Error("Credential fields did not accept the complete values");
  }

  await evaluateInFrame(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find(el => (el.innerText || "").replace(/\\s+/g, "") === "立即登录" && !el.disabled && (el.offsetWidth || el.offsetHeight));
    if (!button) throw new Error("Visible Aliyun login button missing");
    button.click();
    return true;
  })()`, true);

  const deadline = Date.now() + 90_000;
  let result = { status: "timeout" };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const url = await evaluate(target, "location.href").catch(() => "");
    if (url.startsWith("https://common-buy.aliyun.com/")) {
      result = { status: "logged_in", url };
    } else {
      result = await evaluateInFrame(`(() => {
        const text = document.body?.innerText || "";
        const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight));
        const captcha = [...document.querySelectorAll('input[placeholder*="验证码"], iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]')].some(visible);
        const credentialError = /账号(?:名)?或密码错误|密码错误|账号不存在|登录名.*错误/.test(text);
        const mfa = /短信验证|身份验证|二次验证|MFA/.test(text);
        return { status: captcha ? "captcha" : credentialError ? "credential_error" : mfa ? "mfa" : "waiting", url: ${JSON.stringify(url)} };
      })()`).catch(() => ({ status: "navigating", url }));
    }
    if (!["waiting", "navigating"].includes(result.status)) break;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "logged_in") process.exitCode = ["captcha", "mfa"].includes(result.status) ? 3 : 2;
} else if (command === "alimail-init-admin-from-file") {
  const credentialPath = process.argv[3] || "阿里云企业邮箱账号密码.txt";
  const password = (await readFile(credentialPath, "utf8"))
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /密码|pass/i.test(line))
    ?.replace(/^[^:：]*[:：]\s*/, "")
    .trim();
  if (!password) throw new Error("Credential file must contain a labeled password line");

  const target = pageTargets.find((item) => item.url?.startsWith("https://alimail.console.aliyun.com/"));
  if (!target) throw new Error("AliMail console page is not open in the isolated Edge profile");
  const ws = target.webSocketDebuggerUrl;
  const { frameTree } = await cdpCall(ws, "Page.getFrameTree");
  const frames = [];
  const collectFrames = (node) => {
    frames.push(node.frame);
    node.childFrames?.forEach(collectFrames);
  };
  collectFrames(frameTree);

  let contextId;
  for (const frame of frames.filter((item) => item.url === "https://alimail.console.aliyun.com/")) {
    const world = await cdpCall(ws, "Page.createIsolatedWorld", {
      frameId: frame.id,
      worldName: `codex-alimail-admin-${frame.id}`,
    });
    const text = await cdpCall(ws, "Runtime.evaluate", {
      expression: '(document.body?.innerText || "").slice(0, 5000)',
      contextId: world.executionContextId,
      returnByValue: true,
    }).then((result) => result.result?.value || "").catch(() => "");
    if (text.includes("postmaster@dakingscc.cn") && text.includes("设置密码") && text.includes("确认密码")) {
      contextId = world.executionContextId;
      break;
    }
  }
  if (!contextId) throw new Error("AliMail administrator initialization form is not open");

  const evaluateInFrame = async (expression, userGesture = false) => {
    const result = await cdpCall(ws, "Runtime.evaluate", {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "AliMail frame evaluation failed");
    return result.result?.value;
  };
  for (const index of [0, 1]) {
    await evaluateInFrame(`(() => {
      const input = [...document.querySelectorAll('input[type="password"]')]
        .filter((item) => item.offsetWidth || item.offsetHeight)[${index}];
      if (!input) throw new Error("Visible password input missing");
      input.focus();
      input.select();
      return true;
    })()`);
    await replaceFocusedText(ws, password);
  }
  const lengths = await evaluateInFrame(`(() => [...document.querySelectorAll('input[type="password"]')]
    .filter((item) => item.offsetWidth || item.offsetHeight).map((item) => item.value.length))()`);
  if (lengths.length !== 2 || lengths.some((length) => length !== password.length)) {
    throw new Error("AliMail administrator password fields did not accept the complete value");
  }
  await evaluateInFrame(`(() => {
    const submit = [...document.querySelectorAll('[_clk="submit"]')]
      .find((item) => (item.textContent || '').trim() === '提交' && (item.offsetWidth || item.offsetHeight));
    if (!submit) throw new Error("Visible administrator password submit control missing");
    submit.click();
    return true;
  })()`, true);

  const deadline = Date.now() + 30_000;
  let result = { status: "waiting" };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await evaluateInFrame(`(() => {
      const text = document.body?.innerText || '';
      const error = /密码.*(?:错误|不符合|过于简单|强度|失败)|操作失败/.test(text);
      const initialized = /密码初始化[：:]?\s*(?!尚未设置)/.test(text) && !text.includes('设置密码：');
      return { status: error ? 'error' : initialized ? 'initialized' : 'waiting' };
    })()`).catch(() => ({ status: "navigating" }));
    if (!["waiting", "navigating"].includes(result.status)) break;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "initialized") process.exitCode = 2;
} else if (["alimail-login-admin-from-file", "alimail-login-user-from-stdin"].includes(command)) {
  const userLogin = command === "alimail-login-user-from-stdin";
  const domain = userLogin ? "dakingscc.cn" : process.argv[3] || "dakingscc.cn";
  const credentialPath = process.argv[4] || "阿里云企业邮箱账号密码.txt";
  let credentialText = "";
  if (userLogin) {
    for await (const chunk of process.stdin) credentialText += chunk;
  } else {
    credentialText = await readFile(credentialPath, "utf8");
  }
  const password = credentialText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /密码|pass/i.test(line))
    ?.replace(/^[^:：]*[:：]\s*/, "")
    .trim();
  if (!password) throw new Error("Credential file must contain a labeled password line");
  const account = userLogin ? process.argv[3] : process.argv[5] || `postmaster@${domain}`;
  if (!account) throw new Error("AliMail account is required");
  const target = pageTargets.find((item) => item.url?.startsWith("https://qiye.aliyun.com/")
    && (item.url.includes("/alimail/auth/login") || item.url === "https://qiye.aliyun.com/"));
  if (!target) throw new Error("AliMail login page is not open in the isolated Edge profile");
  const ws = target.webSocketDebuggerUrl;
  const { frameTree } = await cdpCall(ws, "Page.getFrameTree");
  const findFrame = (node) => node.frame.url.includes("/login/v2/index")
    ? node.frame
    : node.childFrames?.map(findFrame).find(Boolean);
  const loginFrame = findFrame(frameTree);
  if (!loginFrame) throw new Error("AliMail login iframe is not available");
  const { executionContextId } = await cdpCall(ws, "Page.createIsolatedWorld", {
    frameId: loginFrame.id,
    worldName: "codex-alimail-login",
  });
  const evaluateInFrame = async (expression, userGesture = false) => {
    const result = await cdpCall(ws, "Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "AliMail login frame evaluation failed");
    return result.result?.value;
  };
  for (const [type, value] of [["text", account], ["password", password]]) {
    await evaluateInFrame(`(() => {
      const input = [...document.querySelectorAll('input[type="${type}"]')]
        .find((item) => item.offsetWidth || item.offsetHeight);
      if (!input) throw new Error("Visible ${type} input missing");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
  }
  const prepared = await evaluateInFrame(`(() => {
    const visible = (item) => item.offsetWidth || item.offsetHeight;
    const fields = [...document.querySelectorAll('input')].filter(visible);
    const checks = fields.filter((item) => item.type === 'checkbox');
    const agreement = checks.find((item) => item.closest('label')?.innerText.includes('已阅读并同意'));
    if (!agreement) throw new Error("AliMail agreement checkbox missing");
    if (!agreement.checked) agreement.click();
    return {
      accountLength: fields.find((item) => item.type === 'text')?.value.length || 0,
      passwordLength: fields.find((item) => item.type === 'password')?.value.length || 0,
      agreementChecked: agreement.checked,
    };
  })()`, true);
  if (prepared.accountLength !== account.length || prepared.passwordLength !== password.length || !prepared.agreementChecked) {
    throw new Error("AliMail login form did not accept the complete credentials and agreement");
  }
  if (userLogin) {
    console.log(JSON.stringify({ status: "prepared", account }));
  } else {
    const buttonRect = await evaluateInFrame(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => (item.innerText || '').replace(/\s+/g, '') === '登录' && !item.disabled && (item.offsetWidth || item.offsetHeight));
    if (!button) throw new Error("Visible AliMail login button missing");
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  const frameRect = await evaluate(target, `(() => {
    const frame = [...document.querySelectorAll('iframe')]
      .find((item) => item.src.includes('/login/') && (item.offsetWidth || item.offsetHeight));
    if (!frame) throw new Error("Visible AliMail login iframe missing");
    const rect = frame.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  })()`);
  const clickPoint = { x: frameRect.x + buttonRect.x, y: frameRect.y + buttonRect.y };
  await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", ...clickPoint });
  await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mousePressed", ...clickPoint, button: "left", clickCount: 1 });
  await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", ...clickPoint, button: "left", clickCount: 1 });

  const deadline = Date.now() + 60_000;
  let result = { status: "waiting" };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const topState = await evaluate(target, `(() => ({ url: location.href, text: (document.body?.innerText || '').slice(0, 3000) }))()`)
      .catch(() => ({ url: "", text: "" }));
    if (/至少设置一种身份验证方式|短信验证|身份验证器/.test(topState.text)) {
      result = { status: "mfa", url: topState.url };
      break;
    }
    if ((topState.url.includes("/alimail/entries/") && /收件箱|写邮件/.test(topState.text))
      || (topState.url.startsWith("https://qiye.aliyun.com/")
      && !topState.url.includes("/login/")
      && /员工账号|组织与用户|安全管理|邮箱管理/.test(topState.text))) {
      const url = topState.url;
      result = { status: "logged_in", url };
      break;
    }
    result = await evaluateInFrame(`(() => {
      const text = document.body?.innerText || '';
      const visible = (item) => Boolean(item && (item.offsetWidth || item.offsetHeight));
      const captcha = [...document.querySelectorAll('input[placeholder*="验证码"], iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]')].some(visible);
      const credentialError = /用户名或密码错误|账号或密码错误|密码错误|账号不存在/.test(text);
      const mfa = /短信验证|身份验证|二次验证|动态验证码/.test(text);
      return { status: captcha ? 'captcha' : credentialError ? 'credential_error' : mfa ? 'mfa' : 'waiting' };
    })()`).catch(() => ({ status: "navigating" }));
    if (!["waiting", "navigating"].includes(result.status)) break;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "logged_in") process.exitCode = ["captcha", "mfa"].includes(result.status) ? 3 : 2;
  }
} else if (command === "alimail-fill-open-password") {
  const { createInterface } = await import("node:readline/promises");
  const input = createInterface({ input: process.stdin, terminal: false });
  const password = (await input.question("")).trim();
  input.close();
  if (!password) throw new Error("Account password is required on stdin");
  const target = pageTargets.find((item) => item.url?.startsWith("https://qiye.aliyun.com/admin/"));
  if (!target) throw new Error("AliMail administrator page is not open in the isolated Edge profile");
  const result = await evaluate(target, `(() => {
    const visible = (item) => Boolean(item && (item.offsetWidth || item.offsetHeight));
    const fields = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    if (!fields.length) throw new Error('No visible AliMail password field is open');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const field of fields) {
      setter.call(field, ${JSON.stringify(password)});
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { fieldCount: fields.length, lengths: fields.map((field) => field.value.length) };
  })()`);
  if (result.lengths.some((length) => length !== password.length)) throw new Error("AliMail password fill did not persist");
  console.log(JSON.stringify({ filled: true, fieldCount: result.fieldCount }));
} else if (command === "alimail-save-open-client-password") {
  const account = process.argv[3]?.trim().toLowerCase();
  const destination = process.argv[4];
  if (!/^maggie\d+@dakingscc\.cn$/.test(account || "") || !destination) {
    throw new Error("A valid second-pool account and destination file are required");
  }
  const target = pageTargets.find((item) => item.url?.includes("/alimail/entries/"));
  if (!target) throw new Error("AliMail user page is not open");
  const clientPassword = await evaluate(target, `(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((item) => (item.innerText || '').includes('生成三方客户端安全密码'));
    if (!dialog) throw new Error('Client password dialog is not open');
    const match = (dialog.innerText || '').match(/[A-Za-z0-9]{16}/);
    if (!match) throw new Error('One-time client password was not found');
    return match[0];
  })()`);
  const template = await readFile("deploy/.env.maggie5.auth", "utf8");
  const replaceLine = (text, key, value) => {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (!pattern.test(text)) throw new Error(`Template is missing ${key}`);
    return text.replace(pattern, `${key}=${value}`);
  };
  let content = replaceLine(template, "SMTP_USER", account);
  content = replaceLine(content, "SMTP_PASS", clientPassword);
  content = replaceLine(content, "SMTP_FROM", account);
  await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
  await chmod(destination, 0o600);
  console.log(JSON.stringify({ saved: true, account, destination, passwordLength: clientPassword.length }));
} else if (command === "alimail-create-accounts") {
  const prefixes = process.argv.slice(3).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!prefixes.length || prefixes.some((item) => !/^[a-z][a-z0-9._-]{1,63}$/.test(item))) {
    throw new Error("One or more valid account prefixes are required");
  }
  const { createInterface } = await import("node:readline/promises");
  const input = createInterface({ input: process.stdin, terminal: false });
  const password = (await input.question("")).trim();
  input.close();
  if (!password) throw new Error("Account password is required on stdin");

  const target = pageTargets.find((item) => item.url?.startsWith("https://qiye.aliyun.com/admin/"));
  if (!target) throw new Error("AliMail administrator page is not open in the isolated Edge profile");
  const ws = target.webSocketDebuggerUrl;
  const domain = "dakingscc.cn";
  const waitFor = async (predicate, message, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate().catch(() => null);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(message);
  };
  const fillPlaceholder = async (placeholder, value) => evaluate(target, `(() => {
    const input = [...document.querySelectorAll('input')]
      .find((item) => item.placeholder === ${JSON.stringify(placeholder)} && (item.offsetWidth || item.offsetHeight));
    if (!input) throw new Error("Visible input missing: ${placeholder}");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  const created = [];
  for (const prefix of prefixes) {
    const email = `${prefix}@${domain}`;
    const existing = await evaluate(target, `(() => (document.body?.innerText || '').includes(${JSON.stringify(email)}))()`);
    if (existing) {
      created.push({ email, status: "already_exists" });
      continue;
    }
    const drawerOpen = await evaluate(target, `[...document.querySelectorAll('.ding-mail-drawer-mask')]
      .some((item) => item.offsetWidth || item.offsetHeight)`);
    if (drawerOpen) {
      await cdpCall(ws, "Page.reload", { ignoreCache: false });
      await waitFor(
        () => evaluate(target, `(() => {
          const text = document.body?.innerText || '';
          return text.includes('新建账号') && ![...document.querySelectorAll('.ding-mail-drawer-mask')]
            .some((item) => item.offsetWidth || item.offsetHeight);
        })()`),
        "AliMail account page did not recover from its details drawer",
      );
    }
    let formKind = await evaluate(target, `(() => {
      const visible = (item) => Boolean(item && (item.offsetWidth || item.offsetHeight));
      if ([...document.querySelectorAll('input')].some((item) => item.placeholder === '请输入邮件地址' && visible(item))) return 'modern';
      if (visible(document.querySelector('#confirmPassword'))) return 'legacy';
      return '';
    })()`);
    if (!formKind) {
      const newButton = await evaluate(target, `(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => (item.innerText || '').trim() === '新建账号' && (item.offsetWidth || item.offsetHeight));
        if (!button) throw new Error("Visible new-account button missing");
        button.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await cdpCall(ws, "Page.bringToFront");
      await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", ...newButton, pointerType: "mouse" });
      await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mousePressed", ...newButton, button: "left", clickCount: 1, pointerType: "mouse" });
      await cdpCall(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", ...newButton, button: "left", clickCount: 1, pointerType: "mouse" });
    }
    formKind = await waitFor(
      () => evaluate(target, `(() => {
        const visible = (item) => Boolean(item && (item.offsetWidth || item.offsetHeight));
        if ([...document.querySelectorAll('input')].some((item) => item.placeholder === '请输入邮件地址' && visible(item))) return 'modern';
        if (visible(document.querySelector('#confirmPassword'))) return 'legacy';
        return '';
      })()`),
      "AliMail new-account form did not open",
    );
    const displayName = `${prefix[0].toUpperCase()}${prefix.slice(1)}`;
    let prepared;
    if (formKind === "modern") {
      await fillPlaceholder("请输入姓名", displayName);
      await fillPlaceholder("请输入邮件地址", prefix);
      await fillPlaceholder("请输入", password);
      prepared = await evaluate(target, `(() => {
      const visible = (item) => item.offsetWidth || item.offsetHeight;
      const name = [...document.querySelectorAll('input')].find((item) => item.placeholder === '请输入姓名' && visible(item));
      const address = [...document.querySelectorAll('input')].find((item) => item.placeholder === '请输入邮件地址' && visible(item));
      const passwordInput = [...document.querySelectorAll('input[type="password"]')].find(visible);
      const forceChange = document.querySelector('#forceChangePasswordNextSignIn');
      if (!name || !address || !passwordInput || !forceChange) throw new Error('AliMail account form is incomplete');
      if (forceChange.checked) forceChange.click();
      return {
        name: name.value,
        address: address.value,
        passwordLength: passwordInput.value.length,
        forceChange: forceChange.checked,
        domainVisible: (document.body?.innerText || '').includes('@\\n${domain}'),
      };
    })()`);
    } else {
      prepared = await evaluate(target, `(() => {
        const name = document.querySelector('#name');
        const address = [...document.querySelectorAll('input[type="text"]')]
          .find((item) => item.closest('.next-form-item')?.innerText.includes('默认邮件地址'));
        const passwordInput = document.querySelector('#password');
        const confirmationInput = document.querySelector('#confirmPassword');
        const forceChange = document.querySelector('#initPasswdChanged');
        const allowPop = document.querySelector('#allowPop');
        const allowImap = document.querySelector('#allowImap');
        if (!name || !address || !passwordInput || !confirmationInput || !forceChange || !allowPop || !allowImap) {
          throw new Error('AliMail legacy account form is incomplete');
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const set = (input, value) => {
          setter.call(input, value);
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(name, ${JSON.stringify(displayName)});
        set(address, ${JSON.stringify(prefix)});
        set(passwordInput, ${JSON.stringify(password)});
        set(confirmationInput, ${JSON.stringify(password)});
        if (forceChange.checked) forceChange.click();
        if (!allowPop.checked) allowPop.click();
        if (!allowImap.checked) allowImap.click();
        return {
          name: name.value,
          address: address.value,
          passwordLength: passwordInput.value.length,
          confirmationLength: confirmationInput.value.length,
          forceChange: forceChange.checked,
          servicesEnabled: allowPop.checked && allowImap.checked,
          domainVisible: (document.body?.innerText || '').includes('@${domain}'),
        };
      })()`);
    }
    if (prepared.name !== displayName || prepared.address !== prefix
      || prepared.passwordLength !== password.length
      || (prepared.confirmationLength !== undefined && prepared.confirmationLength !== password.length)
      || prepared.forceChange || prepared.servicesEnabled === false || !prepared.domainVisible) {
      throw new Error(`AliMail account form validation failed for ${email}`);
    }
    const confirmation = await cdpCall(ws, "Runtime.evaluate", {
      expression: `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => (item.innerText || '').trim() === ${JSON.stringify(formKind === "modern" ? "确定" : "保存")}
          && !item.disabled && (item.offsetWidth || item.offsetHeight));
      if (!button) throw new Error('Visible account confirmation button missing');
      button.click();
      return true;
    })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (confirmation.exceptionDetails) throw new Error(`AliMail account confirmation failed for ${email}`);
    const outcome = await waitFor(async () => {
      const state = await evaluate(target, `(() => {
        const text = document.body?.innerText || '';
        const error = [...document.querySelectorAll('[role="alert"], .next-form-item-help, .next-message-content')]
          .filter((item) => item.offsetWidth || item.offsetHeight)
          .map((item) => (item.innerText || '').trim()).filter(Boolean).join(' | ');
        return {
          exists: text.includes(${JSON.stringify(email)}),
          formOpen: Boolean([...document.querySelectorAll('input')]
            .find((item) => item.placeholder === '请输入邮件地址' && (item.offsetWidth || item.offsetHeight)))
            || Boolean(document.querySelector('#confirmPassword')?.offsetWidth || document.querySelector('#confirmPassword')?.offsetHeight),
          error,
        };
      })()`);
      if (state.error && state.formOpen) throw new Error(`AliMail rejected ${email}: ${state.error}`);
      return state.exists && !state.formOpen ? state : null;
    }, `AliMail did not confirm creation of ${email}`);
    created.push({ email, status: outcome.exists ? "created" : "unknown" });
  }
  console.log(JSON.stringify({ created }, null, 2));
} else if (command === "type-company") {
  const targetId = process.argv[3];
  const companyName = process.argv.slice(4).join(" ");
  const target = pageTargets.find((item) => item.id === targetId);
  if (!target) throw new Error(`Page target not found: ${targetId}`);
  const focused = await evaluate(target, `(() => {
    const input = [...document.querySelectorAll("input")].find(el => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight));
    if (!input) throw new Error("Company input missing");
    input.focus();
    return document.activeElement === input;
  })()`);
  if (!focused) throw new Error("Company input could not be focused");
  const ws = target.webSocketDebuggerUrl;
  await evaluate(target, `(() => {
    const input = [...document.querySelectorAll("input")]
      .find(el => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight));
    input.focus();
    input.select();
    return input.selectionStart === 0 && input.selectionEnd === input.value.length;
  })()`);
  await replaceFocusedText(ws, companyName);
  const submittedValue = await evaluate(target, `(() => [...document.querySelectorAll("input")]
    .find(el => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight))?.value || "")()`);
  if (submittedValue !== companyName) {
    throw new Error(`Company input mismatch: expected ${companyName}, got ${submittedValue}`);
  }
  await evaluate(target, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find(el => (el.innerText || "").trim() === "搜索" && !el.disabled && (el.offsetWidth || el.offsetHeight));
    if (!button) throw new Error("Visible search button missing");
    const key = Object.getOwnPropertyNames(button).find(name => name.startsWith("__reactEventHandlers$"));
    if (!key || typeof button[key]?.onClick !== "function") throw new Error("Search React handler missing");
    button[key].onClick({ currentTarget: button, target: button, type: "click", nativeEvent: new MouseEvent("click"), preventDefault(){}, stopPropagation(){} });
    return true;
  })()`);
  console.log(JSON.stringify({ typed: companyName, submitted: true }, null, 2));
} else if (command === "search-company-exact") {
  const companyName = process.argv.slice(3).join(" ").trim();
  if (!companyName) throw new Error("Company name is required");
  const ready = selectBusinessTarget(await inspectedPages());
  const target = ready.target;
  const ws = target.webSocketDebuggerUrl;
  await evaluate(target, `(() => {
    for (const button of document.querySelectorAll('.ant-drawer-close')) {
      if (button.offsetWidth || button.offsetHeight) button.click();
    }
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await evaluate(target, `(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const keyword = tabs.find(el => (el.innerText || "").trim() === "按关键词");
    if (!keyword) throw new Error("Keyword tab missing");
    keyword.click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await evaluate(target, `(() => {
    const company = document.querySelector('#rc-tabs-2-tab-company')
      || [...document.querySelectorAll('[role="tab"]')]
        .find(el => (el.innerText || "").trim() === "按公司"
          && el.closest('[data-track-component="CustomsSearch"]'));
    if (!company) throw new Error("Company tab missing");
    company.click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await evaluate(target, `(() => {
    const exact = [...document.querySelectorAll('.customsSearch-module--precise--si5IV input[type="checkbox"]')]
      .find(el => (el.offsetWidth || el.offsetHeight));
    if (!exact) throw new Error("Exact checkbox missing");
    const input = [...document.querySelectorAll("input")]
      .find(el => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight));
    if (!input) throw new Error("Company input missing");
    const exactKey = Object.getOwnPropertyNames(exact).find(key => key.startsWith("__reactEventHandlers$"));
    const inputKey = Object.getOwnPropertyNames(input).find(key => key.startsWith("__reactEventHandlers$"));
    if (!exactKey || typeof exact[exactKey]?.onChange !== "function") throw new Error("Exact React handler missing");
    if (!inputKey || typeof input[inputKey]?.onChange !== "function") throw new Error("Company React handler missing");
    if (!exact[exactKey].checked) {
      exact[exactKey].onChange({ target: { checked: true }, currentTarget: exact, type: "change", nativeEvent: new Event("change"), preventDefault(){}, stopPropagation(){} });
    }
    input[inputKey].onChange({ target: { value: ${JSON.stringify(companyName)} }, currentTarget: input, type: "change", nativeEvent: new Event("input"), preventDefault(){}, stopPropagation(){} });
    input.focus();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const submittedValue = await evaluate(target, `(() => [...document.querySelectorAll("input")]
    .find(el => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight))?.value || "")()`);
  if (submittedValue !== companyName) {
    throw new Error(`Company input mismatch: expected ${companyName}, got ${submittedValue}`);
  }
  const requestCountBefore = await evaluate(target, `performance.getEntriesByType("resource")
    .filter(entry => entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest").length`);
  const resultSignatureBefore = await evaluate(target, `(() => {
    const table = [...document.querySelectorAll("table")]
      .find(el => el.querySelector('tr[data-row-key]') && el.innerText.includes("一键营销"));
    return table?.innerText || "";
  })()`);
  await cdpCall(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdpCall(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const deadline = Date.now() + 20_000;
  let result;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await evaluate(target, `(() => {
      const text = document.body?.innerText || "";
      const input = [...document.querySelectorAll("input")]
        .find(el => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight));
      const exact = [...document.querySelectorAll('.customsSearch-module--precise--si5IV input[type="checkbox"]')]
        .find(el => (el.offsetWidth || el.offsetHeight));
      const countMatch = text.match(/为您找到\\s*([0-9+]+)\\s*个结果/);
      const requestCount = performance.getEntriesByType("resource")
        .filter(entry => entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest").length;
      const table = [...document.querySelectorAll("table")]
        .find(el => el.querySelector('tr[data-row-key]') && el.innerText.includes("一键营销"));
      const resultSignature = table?.innerText || "";
      const explicitEmpty = text.includes("暂无数据，可尝试去网页搜索最新内容");
      const rendered = Boolean(table) || explicitEmpty;
      return {
        submittedValue: input?.value || "",
        exact: Boolean(exact?.checked),
        resultCount: countMatch?.[1] || "",
        resultReady: Boolean(countMatch) && rendered,
        rendered,
        resultFresh: requestCount > ${requestCountBefore} || resultSignature !== ${JSON.stringify(resultSignatureBefore)},
        captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some(el => el.offsetWidth || el.offsetHeight),
        rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
        accountError: /权限不足|账号异常|登录已失效|重新登录/.test(text),
      };
    })()`);
    if (result.captcha || result.rateLimited || result.accountError || (result.resultReady && result.resultFresh)) break;
  }
  if ((!result?.resultReady || !result?.resultFresh) && !result?.captcha && !result?.rateLimited && !result?.accountError) {
    throw new Error("Search produced no fresh result response or safety signal within 20 seconds");
  }
  console.log(JSON.stringify({ targetId: ready.targetId, companyName, ...result }, null, 2));
} else if (command === "collect-current-visible") {
  const queryMarker = process.argv.indexOf("--submitted-query");
  const contactPageMarker = process.argv.indexOf("--contact-page");
  const expectedCompany = process.argv.slice(3, queryMarker > 0 ? queryMarker : undefined).join(" ").trim();
  const submittedQuery = queryMarker > 0
    ? process.argv.slice(queryMarker + 1, contactPageMarker > queryMarker ? contactPageMarker : undefined).join(" ").trim()
    : expectedCompany;
  const requestedContactPage = Math.max(1, Number.parseInt(process.argv[contactPageMarker + 1] || "1", 10) || 1);
  const targetIdMarker = process.argv.indexOf("--target-id");
  const resultSignatureMarker = process.argv.indexOf("--result-signature");
  const boundTargetId = targetIdMarker > 0 ? String(process.argv[targetIdMarker + 1] || "").trim() : "";
  const boundResultSignature = resultSignatureMarker > 0 ? String(process.argv[resultSignatureMarker + 1] || "") : "";
  if (!expectedCompany) throw new Error("Expected company name is required");
  if (!submittedQuery) throw new Error("Submitted company query is required");
  const inspected = await inspectedPages();
  const ready = boundTargetId
    ? inspected.find((item) => item.targetId === boundTargetId && item.state?.businessReady)
    : selectBusinessTarget(inspected);
  if (boundTargetId && !ready) throw new Error(`TARGET_CHANGED: bound target ${boundTargetId} is no longer business-ready`);
  const target = ready.target;
  const initial = await evaluate(target, `(() => {
    const text = document.body?.innerText || "";
    const input = [...document.querySelectorAll("input")]
      .find(el => el.placeholder === "请输入公司名称" && (el.offsetWidth || el.offsetHeight));
    const exact = [...document.querySelectorAll('.customsSearch-module--precise--si5IV input[type="checkbox"]')]
      .find(el => (el.offsetWidth || el.offsetHeight));
    const countMatch = text.match(/为您找到\\s*([0-9+]+)\\s*个结果/);
    const tables = [...document.querySelectorAll("table")];
    const resultTable = tables.find(table => table.querySelector('tr[data-row-key]')
      && table.innerText.includes("一键营销") && table.innerText.includes("深挖联系人"));
    const rows = resultTable ? [...resultTable.querySelectorAll('tr[data-row-key]')] : [];
    return {
      submittedValue: input?.value || "",
      exact: Boolean(exact?.checked),
      resultCount: countMatch?.[1] || "",
      rows: rows.map((row, index) => ({
        index,
        name: row.querySelector('[class*="table-company-name-box-length"]')?.innerText?.trim()
          || row.querySelector('[class*="table-company-name"]')?.innerText?.trim() || "",
        text: row.innerText || "",
      })),
      resultSignature: resultTable?.innerText?.trim() || (text.includes("暂无数据，可尝试去网页搜索最新内容") ? "empty:" + (countMatch?.[1] || "0") : ""),
      captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i], input[placeholder*="验证码"]')].some(el => el.offsetWidth || el.offsetHeight),
      rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
      accountError: /权限不足|账号异常|登录已失效|重新登录/.test(text),
    };
  })()`);
  if (initial.captcha || initial.rateLimited || initial.accountError) {
    console.log(JSON.stringify({ targetId: ready.targetId, expectedCompany, safety: initial }, null, 2));
    process.exitCode = 3;
  } else {
    if (boundTargetId && ready.targetId !== boundTargetId) throw new Error(`TARGET_CHANGED: expected ${boundTargetId}, got ${ready.targetId}`);
    if (initial.submittedValue !== submittedQuery) throw new Error(`SEARCH_STATE_MISMATCH: expected ${submittedQuery}, got ${initial.submittedValue}`);
    if (!initial.exact) throw new Error("EXACT_MODE_LOST: exact mode is no longer enabled");
    if (boundResultSignature && initial.resultSignature !== boundResultSignature) throw new Error("SEARCH_STATE_MISMATCH: result signature changed before collection");
    const normalizeName = (value) => value.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const expectedNormalized = normalizeName(expectedCompany);
    const queryNormalized = normalizeName(submittedQuery);
    const matchingRows = initial.rows.filter((row) => {
      const rowNormalized = normalizeName(row.name);
      return rowNormalized === queryNormalized
        || (rowNormalized.length >= 6 && expectedNormalized.startsWith(rowNormalized));
    });
    if (initial.resultCount === "0") {
      console.log(JSON.stringify({
        targetId: ready.targetId,
        expectedCompany,
        status: "no_result",
        matchConfidence: "no_exact_result",
        company: {},
        contacts: [],
        note: "Company-mode exact query returned zero visible results.",
      }, null, 2));
    } else if (!initial.rows.length) {
      throw new Error("Result count is nonzero but visible result rows were not located");
    } else if (matchingRows.length !== 1) {
      console.log(JSON.stringify({
        targetId: ready.targetId,
        expectedCompany,
        status: "collected",
        matchConfidence: "same_name_or_nonidentical_results",
        company: {},
        contacts: [],
        visibleCandidates: initial.rows.map(row => ({ name: row.name, text: row.text.slice(0, 1200) })),
        note: "Multiple or non-identical visible records require manual entity resolution; no contact rows were assigned.",
      }, null, 2));
    } else {
      const selectedRowIndex = matchingRows[0].index;
      const clicked = await evaluate(target, `(() => {
        const tables = [...document.querySelectorAll("table")];
        const resultTable = tables.find(table => table.innerText.includes("一键营销") && table.innerText.includes("深挖联系人"));
        const row = [...(resultTable?.querySelectorAll('tr[data-row-key]') || [])][${selectedRowIndex}];
        const trigger = row?.querySelector('[class*="tableColumn-num"]');
        if (!trigger) throw new Error("Visible contact-count trigger missing");
        trigger.click();
        return true;
      })()`);
      if (!clicked) throw new Error("Company detail did not open");
      if (requestedContactPage > 1) {
        await evaluate(target, `(async () => {
          const deadline = Date.now() + 20_000;
          const currentPage = () => {
            const drawer = [...document.querySelectorAll('.ant-drawer-content')]
              .filter(el => (el.offsetWidth || el.offsetHeight) && el.innerText.includes("联系人")).at(-1);
            const pagination = drawer?.querySelector('.ant-pagination');
            return Number(pagination?.querySelector('.ant-pagination-item-active')?.getAttribute('title') || 1);
          };
          while (currentPage() < ${requestedContactPage} && Date.now() < deadline) {
            const drawer = [...document.querySelectorAll('.ant-drawer-content')]
              .filter(el => (el.offsetWidth || el.offsetHeight) && el.innerText.includes("联系人")).at(-1);
            const pagination = drawer?.querySelector('.ant-pagination');
            const next = pagination?.querySelector('.ant-pagination-next:not(.ant-pagination-disabled)');
            if (!next) throw new Error("Requested contact page is unavailable");
            const button = next.querySelector('button');
            if (button) button.click(); else next.click();
            await new Promise(resolve => setTimeout(resolve, 700));
          }
          if (currentPage() !== ${requestedContactPage}) throw new Error("Contact pagination did not reach requested page");
          return true;
        })()`);
      }
      const deadline = Date.now() + 15_000;
      let collected;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        collected = await evaluate(target, `(() => {
          const text = document.body?.innerText || "";
          const drawers = [...document.querySelectorAll('.ant-drawer-content')]
            .filter(el => (el.offsetWidth || el.offsetHeight) && el.innerText.includes("联系人"));
          const drawer = drawers.at(-1);
          if (!drawer) return { ready: false };
          const drawerText = drawer.innerText || "";
          const totalMatch = drawerText.match(/共找到\\s*([0-9,]+)\\s*个联系人/);
          const tables = [...drawer.querySelectorAll("table")];
          const contactTable = tables.find(table => table.innerText.includes("姓名/职位") || table.parentElement?.innerText.includes("共找到"));
          const dataTable = tables.find(table => table.querySelector('tr[data-row-key]'));
          const rows = dataTable ? [...dataTable.querySelectorAll('tr[data-row-key]')] : [];
          const pagination = drawer.querySelector('.ant-pagination');
          const activePage = Number(pagination?.querySelector('.ant-pagination-item-active')?.getAttribute('title') || ${requestedContactPage});
          const nextButton = pagination?.querySelector('.ant-pagination-next');
          const hasNextPage = Boolean(nextButton && !nextButton.classList.contains('ant-pagination-disabled') && nextButton.getAttribute('aria-disabled') !== 'true');
          const valueAfter = (label) => {
            const match = drawerText.match(new RegExp(label + "\\\\s*\\\\n([^\\\\n]+)"));
            return match?.[1]?.trim() || "";
          };
          const website = valueAfter("公司官网：");
          return {
            ready: drawerText.includes("共找到") || drawerText.includes("联系人信息较少") || rows.length > 0,
            contactTotal: Number(String(totalMatch?.[1] || "0").replaceAll(",", "")) || 0,
            contactPage: activePage,
            contactPageSize: rows.length,
            contactNextPage: hasNextPage ? activePage + 1 : activePage,
            contactPagesCollected: activePage,
            contactComplete: !hasNextPage,
            company: {
              name: drawerText.split("\\n")[0]?.trim() || "",
              country: valueAfter("国家地区："),
              website,
              domain: (() => { try { return new URL(website).hostname.replace(/^www\\./, ""); } catch { return ""; } })(),
              phone: valueAfter("公司电话："),
              industry: valueAfter("所属行业："),
              products: valueAfter("主营产品："),
              founded: valueAfter("成立年份："),
              employeeCount: valueAfter("员工数："),
              address: valueAfter("公司地址："),
              source: "NetEase global search visible company detail",
            },
            contacts: rows.map(row => {
              const name = row.querySelector('[class*="global-search-table-name"] [class*="name"]')?.innerText?.split("\\n")[0]?.trim()
                || row.querySelector('[class*="global-search-table-name"]')?.innerText?.split("\\n")[0]?.trim() || "";
              const titleRaw = row.querySelector('[class*="global-search-table-sub-name"]')?.innerText?.trim() || "";
              const titleParts = titleRaw.split("\\n").map(value => value.trim()).filter(Boolean);
              const title = [...new Set(titleParts)].join("; ");
              const email = row.querySelector('[class*="email-text"]')?.innerText?.trim() || "";
              const phoneNode = row.querySelector('[class*="iconPhone"]')?.parentElement;
              const phone = phoneNode?.innerText?.trim() || "";
              const linkedin = [...row.querySelectorAll('a[href]')].find(a => /linkedin\\.com/i.test(a.href))?.href || "";
              const source = [...new Set((row.cells?.[3]?.innerText || "").split("\\n").map(value => value.trim()).filter(Boolean))].join("; ");
              return { name, title, email, phone, linkedin, source: "NetEase visible contact row; " + (source || "public visible") + "; unverified" };
            }),
            drawerText: drawerText.slice(0, 10000),
            safety: {
              captcha: /(?:需要|请|点击|输入|完成|人机|安全).{0,20}(?:验证码|安全验证)|(?:验证码|安全验证).{0,20}(?:弹窗|输入|失败|过期|重试)/.test(text) || [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[src*="yidun" i], [id*="captcha" i], [class*="captcha" i], [class*="yidun" i], input[placeholder*="验证码"]')].some(el => el.offsetWidth || el.offsetHeight),
              rateLimited: /操作频繁|访问过于频繁|请求过于频繁/.test(text),
              accountError: /权限不足|账号异常|登录已失效|重新登录/.test(text),
            },
          };
        })()`);
        if (collected?.ready || collected?.safety?.captcha || collected?.safety?.rateLimited || collected?.safety?.accountError) break;
      }
      if (!collected?.ready) throw new Error("Company detail/contact rows did not render within 15 seconds");
      if (collected.safety.captcha || collected.safety.rateLimited || collected.safety.accountError) {
        console.log(JSON.stringify({ targetId: ready.targetId, expectedCompany, safety: collected.safety }, null, 2));
        process.exitCode = 3;
      } else {
        console.log(JSON.stringify({
          targetId: ready.targetId,
          expectedCompany,
          submittedQuery,
          status: collected.contacts.length ? (collected.contactComplete ? "collected" : "partial") : "company_visible_no_contacts",
          matchConfidence: submittedQuery === expectedCompany ? "exact_name_unique_record" : "cleaned_core_unique_record",
          company: collected.company,
          contacts: collected.contacts,
          contactRowsDelta: collected.contacts.length,
          contactTotal: collected.contactTotal,
          contactPage: collected.contactPage,
          contactPageSize: collected.contactPageSize,
          contactNextPage: collected.contactNextPage,
          contactPagesCollected: collected.contactPagesCollected,
          contactComplete: collected.contactComplete,
          note: `Unique exact-name record; retained ${collected.contacts.length} visible contact rows from page ${collected.contactPage}${collected.contactComplete ? " (last page)" : "; remaining pages are queued for continuation"}.`,
        }, null, 2));
      }
    }
  }
} else {
  throw new Error(`Unknown command: ${command}`);
}
