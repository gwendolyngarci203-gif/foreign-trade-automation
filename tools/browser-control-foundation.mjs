import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const defaultWsModule = path.join(import.meta.dirname, "..", "browser-runtime", "node_modules", "ws");
const WebSocket = globalThis.WebSocket || require(process.env.WS_MODULE || defaultWsModule).WebSocket;

export class BrowserControlError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "BrowserControlError";
    this.code = code;
    this.stage = context.stage || "unknown";
    this.targetId = context.targetId || "";
    this.url = context.url || "";
    this.elapsedMs = Number(context.elapsedMs || 0);
    this.timeoutMs = Number(context.timeoutMs || 0);
  }

  toJSON() {
    return {
      code: this.code,
      stage: this.stage,
      targetId: this.targetId,
      url: this.url,
      elapsedMs: this.elapsedMs,
      timeoutMs: this.timeoutMs,
      message: this.message,
    };
  }
}

export async function withTimeout(operation, context = {}) {
  const started = Date.now();
  const timeoutMs = Number(context.timeoutMs || 5_000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          context.onTimeout?.();
          reject(new BrowserControlError(
            context.code || "DOM_EVALUATION_TIMEOUT",
            `${context.stage || "operation"} timed out`,
            { ...context, elapsedMs: Date.now() - started, timeoutMs },
          ));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof BrowserControlError) throw error;
    throw new BrowserControlError(
      context.code || "CDP_ENDPOINT_ERROR",
      error?.message || String(error),
      { ...context, elapsedMs: Date.now() - started, timeoutMs },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function cdpEvaluate(target, expression, timeoutMs = 5_000) {
  const started = Date.now();
  let socket;
  return withTimeout(() => new Promise((resolve, reject) => {
    socket = new WebSocket(target.webSocketDebuggerUrl);
    const close = () => { try { socket.close(); } catch {} };
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: false, userGesture: false },
    })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      close();
      if (message.error) return reject(new BrowserControlError(
        "RENDERER_HUNG",
        message.error.message,
        { stage: "runtime.evaluate", targetId: target.id, url: target.url, elapsedMs: Date.now() - started, timeoutMs },
      ));
      if (message.result?.exceptionDetails) return reject(new BrowserControlError(
        "DOM_EVALUATION_TIMEOUT",
        message.result.exceptionDetails.text || "Runtime evaluation failed",
        { stage: "runtime.evaluate", targetId: target.id, url: target.url, elapsedMs: Date.now() - started, timeoutMs },
      ));
      resolve(message.result?.result?.value);
    });
    socket.addEventListener("error", () => reject(new BrowserControlError(
      "WEBSOCKET_TIMEOUT",
      "CDP websocket error",
      { stage: "runtime.evaluate", targetId: target.id, url: target.url, elapsedMs: Date.now() - started, timeoutMs },
    )));
  }), { stage: "runtime.evaluate", targetId: target.id, url: target.url, timeoutMs, code: "DOM_EVALUATION_TIMEOUT", onTimeout: () => { try { socket?.close(); } catch {} } });
}
