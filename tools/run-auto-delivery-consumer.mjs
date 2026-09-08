const response = await fetch("http://127.0.0.1:4173/api/system-alert-canary/consume", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ confirm: "RUN AUTO DELIVERY CANARY", canary: true }),
  signal: AbortSignal.timeout(60_000),
});
const body = await response.json().catch(() => ({}));
console.log(JSON.stringify({ httpStatus: response.status, ...body }, null, 2));
if (!response.ok) process.exitCode = 1;
