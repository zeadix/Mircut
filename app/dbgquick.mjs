import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
const server = spawn("npx", ["vite", "--port", "5198", "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => console.log("[vite]", d.toString().trim().slice(0, 200)));
server.stderr.on("data", (d) => console.log("[vite-err]", d.toString().trim().slice(0, 400)));
await new Promise((r) => setTimeout(r, 5000));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 300), "\n", (e.stack || "").split("\n").slice(1, 4).join("\n")));
await page.goto("http://localhost:5198/", { waitUntil: "networkidle" });
try {
  await page.waitForSelector(".asset-card", { timeout: 8000 });
  console.log("OK: asset-card visible");
} catch {
  console.log("FAIL: no asset-card; body:", (await page.evaluate(() => document.body.innerText.slice(0, 200))).replace(/\n/g, "|"));
}
await browser.close();
server.kill();
