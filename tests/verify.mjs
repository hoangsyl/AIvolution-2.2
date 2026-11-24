/**
 * AIvolution 2.0 — Automated Syntax, Security, API Handler & Regression Verification Suite
 * Run: node tests/verify.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

function createMockRes() {
  const headers = {};
  let statusCode = 200;
  let body = null;
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    status(code) { statusCode = code; return res; },
    json(data) { body = data; return res; },
    end() { return res; },
    _get() { return { statusCode, headers, body }; }
  };
  return res;
}

console.log("=== 1. SYNTAX & JSON VALIDATION ===");
const jsFiles = [
  "app.js",
  "sw.js",
  "api/_lib/security.js",
  "api/_lib/ai-client.js",
  "api/scan.js",
  "api/explore.js",
  "api/nearby-places.js",
  "api/planner.js",
  "api/search.js",
  "api/weather.js",
  ...fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js")).map((f) => path.join("js", f))
];

for (const rel of jsFiles) {
  await test(`Syntax check: ${rel}`, () => {
    execFileSync(process.execPath, ["--check", path.join(ROOT, rel)], { stdio: "pipe" });
  });
}

for (const jf of ["manifest.json", "vercel.json", ".well-known/assetlinks.json"]) {
  await test(`Valid JSON: ${jf}`, () => {
    const raw = fs.readFileSync(path.join(ROOT, jf), "utf8");
    JSON.parse(raw);
  });
}

console.log("\n=== 2. SECURITY & INPUT VALIDATION TESTS ===");
const security = require(path.join(ROOT, "api/_lib/security.js"));

await test("Magic-byte image validator rejects fake text disguised as JPEG", () => {
  const fake = "data:image/jpeg;base64," + Buffer.from("not an actual jpeg file contents!!").toString("base64");
  const r = security.validateImageBase64(fake);
  assert.equal(r.valid, false);
});

await test("Magic-byte image validator accepts valid PNG header", () => {
  const pngHeader = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const r = security.validateImageBase64(`data:image/png;base64,${pngHeader.toString("base64")}`);
  assert.equal(r.valid, true);
  assert.equal(r.mime, "image/png");
});

await test("URL sanitizer blocks javascript: and data: XSS vectors", () => {
  assert.equal(security.sanitizeExternalUrl("javascript:alert(1)"), "");
  assert.equal(security.sanitizeExternalUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(security.sanitizeExternalUrl("https://aitl-teal.vercel.app/test"), "https://aitl-teal.vercel.app/test");
});

await test("Chat validator rejects empty messages and caps length", () => {
  assert.equal(security.validateChatMessages([]).valid, false);
  const longText = "a".repeat(3000);
  const r = security.validateChatMessages([{ role: "user", content: longText }]);
  assert.equal(r.valid, true);
  assert.equal(r.messages[0].content.length, security.LIMITS.MAX_CHAT_MESSAGE_CHARS);
});

console.log("\n=== 3. API HANDLER INTEGRATION TESTS (NO EXTERNAL KEYS) ===");
const scanHandler = require(path.join(ROOT, "api/scan.js"));
const nearbyHandler = require(path.join(ROOT, "api/nearby-places.js"));
const plannerHandler = require(path.join(ROOT, "api/planner.js"));
const searchHandler = require(path.join(ROOT, "api/search.js"));
const exploreHandler = require(path.join(ROOT, "api/explore.js"));

await test("GET /api/scan?mode=status returns 200 with security headers and no secrets", async () => {
  const res = createMockRes();
  await scanHandler({ method: "GET", query: { mode: "status" }, headers: {} }, res);
  const out = res._get();
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers["x-content-type-options"], "nosniff");
  assert.equal(out.headers["x-frame-options"], "DENY");
  assert.equal(out.body.ok, true);
  assert.equal(typeof out.body.services.groqConfigured, "boolean");
});

await test("POST /api/scan without API keys returns 503 MISSING_API_KEY (no debug leak)", async () => {
  const res = createMockRes();
  await scanHandler({ method: "POST", body: { imageBase64: "abc" }, headers: { "x-forwarded-for": "1.1.1.1" } }, res);
  const out = res._get();
  assert.equal(out.statusCode, 503);
  assert.equal(out.body.code, "MISSING_API_KEY");
  assert.equal(out.body.debug, undefined);
});

await test("GET /api/nearby-places rejects invalid GPS coordinates with 400", async () => {
  const res = createMockRes();
  await nearbyHandler({ method: "GET", query: { lat: "abc", lng: "999" }, headers: { "x-forwarded-for": "1.1.1.2" } }, res);
  assert.equal(res._get().statusCode, 400);
});

await test("POST /api/planner rejects GET method with 405", async () => {
  const res = createMockRes();
  await plannerHandler({ method: "GET", headers: {} }, res);
  assert.equal(res._get().statusCode, 405);
});

await test("POST /api/planner without API keys returns 503 MISSING_API_KEY", async () => {
  const res = createMockRes();
  await plannerHandler({ method: "POST", body: { city: "Đà Nẵng", days: 2, budgetVnd: 1000000 }, headers: { "x-forwarded-for": "1.1.1.3" } }, res);
  assert.equal(res._get().statusCode, 503);
  assert.equal(res._get().body.code, "MISSING_API_KEY");
});

await test("GET /api/search rejects 1-char query with 400", async () => {
  const res = createMockRes();
  await searchHandler({ method: "GET", query: { q: "a" }, headers: { "x-forwarded-for": "1.1.1.4" } }, res);
  assert.equal(res._get().statusCode, 400);
});

await test("GET /api/explore rejects POST method with 405", async () => {
  const res = createMockRes();
  await exploreHandler({ method: "POST", headers: {} }, res);
  assert.equal(res._get().statusCode, 405);
});

await test("Rate limiter triggers 429 after exceeding scope limit", async () => {
  let hit429 = false;
  for (let i = 0; i < 35; i++) {
    const res = createMockRes();
    await searchHandler({ method: "GET", query: { q: "a" }, headers: { "x-forwarded-for": "9.9.9.9", "x-aivolution-session": "test_session_1234" } }, res);
    if (res._get().statusCode === 429) {
      hit429 = true;
      break;
    }
  }
  assert.equal(hit429, true);
});

console.log("\n=== 4. FRONTEND UTILS & PRESERVATION CHECKS ===");
await test("Frontend Markdown renderer neutralizes <script> and javascript: links", async () => {
  globalThis.window = { location: { origin: "https://aitl-teal.vercel.app" } };
  const utils = await import("../js/utils.js");
  const html = utils.renderSafeMarkdown('Hello <script>alert(1)</script> [click](javascript:alert(2)) **bold**');
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<a "), false);
  assert.equal(html.includes("<strong>bold</strong>"), true);
});

await test("Preserved original assets exist (IMG_1713.png, assetlinks.json)", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "IMG_1713.png")), true);
  assert.equal(fs.existsSync(path.join(ROOT, ".well-known/assetlinks.json")), true);
});

console.log(`\n=== SUMMARY: ${passed} PASSED, ${failed} FAILED ===`);
if (failed > 0) process.exit(1);
