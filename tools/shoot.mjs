// Capture the four surfaces as PNGs.
//
// Optional. Needs a Chromium that Playwright can find, either a local install or
// one downloaded with `npx playwright install chromium`. If there is no browser
// this exits with an explanation rather than a stack trace, because the product
// does not depend on it.
//
//   npm run png
//
// Writes docs/screens/*.png at 2x, which is what a design review wants.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = new URL("../docs/screens/", import.meta.url);
const BASE = process.env.HASP_URL || "http://localhost:3000";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

await mkdir(OUT, { recursive: true });

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.log(`No Chromium available: ${String(err.message).split("\n")[0]}`);
  console.log("The product does not need this step. Install a browser only if you want the PNGs.");
  process.exit(0);
}

const SHOTS = [
  { name: "themes", url: "/themes.html", width: 1440, height: 1200, fullPage: true },
  { name: "foundry-light", url: "/", width: 1400, height: 900, dir: "foundry", mode: "light" },
  { name: "foundry-dark", url: "/", width: 1400, height: 900, dir: "foundry", mode: "dark" },
  { name: "nightshift-dark", url: "/", width: 1400, height: 900, dir: "nightshift", mode: "dark" },
  { name: "nightshift-light", url: "/", width: 1400, height: 900, dir: "nightshift", mode: "light" },
  { name: "nightshift-dark-narrow", url: "/", width: 820, height: 1000, dir: "nightshift", mode: "dark" },
  { name: "foundry-light-narrow", url: "/", width: 820, height: 1000, dir: "foundry", mode: "light" },
];

const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
const page = await context.newPage();

// Unlock once; the cookie carries for the rest.
await page.goto(`${BASE}/themes.html`, { waitUntil: "load" });
await page.goto(`${BASE}/`, { waitUntil: "load" });
if (await page.locator("#master").count()) {
  await page.locator("#master").fill("foundry-nightshift-2026");
  await page.locator('button[type="submit"]').click();
  await page.locator(".rail").waitFor();
}

for (const shot of SHOTS) {
  if (shot.dir) {
    await page.evaluate(
      ([dir, mode]) => {
        localStorage.setItem("hasp.direction", dir);
        localStorage.setItem("hasp.mode", mode);
      },
      [shot.dir, shot.mode]
    );
  }
  await page.setViewportSize({ width: shot.width, height: shot.height });
  await page.goto(`${BASE}${shot.url}`, { waitUntil: "load" });
  await page.waitForTimeout(450); // fonts, images, the first code tick
  const file = new URL(`${shot.name}.png`, OUT);
  await page.screenshot({ path: file.pathname, fullPage: Boolean(shot.fullPage) });
  console.log(`wrote docs/screens/${shot.name}.png`);
}

await browser.close();
console.log(`Done. ${existsSync(new URL("themes.png", OUT)) ? "Open docs/screens/themes.png first." : ""}`);
