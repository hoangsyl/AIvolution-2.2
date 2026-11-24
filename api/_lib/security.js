/**
 * AIvolution 2.0 — Shared Security, Validation, CORS & Distributed Rate Limiting
 * Supports Upstash Redis REST API for multi-instance serverless rate limiting,
 * with automatic graceful in-memory fallback when Redis is not configured.
 */

const crypto = require("crypto");

const MEMORY_RATE_LIMITS = new Map();
const MAX_MEM_BUCKETS = 2000;

const LIMITS = {
  MAX_IMAGE_BYTES: 4 * 1024 * 1024, // 4 MB decoded binary
  MAX_IMAGE_BASE64_CHARS: 5.6 * 1024 * 1024,
  MAX_CHAT_MESSAGE_CHARS: 1500,
  MAX_CHAT_HISTORY_ITEMS: 14,
  MAX_TTS_CHARS: 1200,
  MAX_SEARCH_QUERY_CHARS: 180,
  MAX_PLANNER_PROMPT_CHARS: 500
};

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0].trim().slice(0, 64);
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim().slice(0, 64);
  }
  return req.socket?.remoteAddress || "unknown";
}

function getSessionId(req) {
  const raw = String(req.headers["x-aivolution-session"] || "").trim();
  if (/^[a-zA-Z0-9_-]{8,64}$/.test(raw)) return raw;
  return "anon";
}

function applySecurityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), geolocation=(self), microphone=(self)");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const origin = req.headers.origin;
  if (origin) {
    const allowedEnv = String(process.env.ALLOWED_ORIGINS || "")
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const host = req.headers.host ? `https://${req.headers.host}` : "";
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    const isVercelSelf = Boolean(host && origin.toLowerCase() === host.toLowerCase());
    const isAllowed =
      isVercelSelf ||
      isLocalhost ||
      allowedEnv.includes("*") ||
      allowedEnv.some((o) => o.toLowerCase() === origin.toLowerCase());

    if (isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AIvolution-Session");
    }
  }
}

async function checkUpstashRateLimit(key, maxRequests, windowSec) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const pipelineUrl = `${url.replace(/\/+$/, "")}/pipeline`;
    const res = await fetch(pipelineUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(windowSec), "NX"]
      ]),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    const count = Number(data?.[0]?.result || 0);
    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      limit: maxRequests,
      backend: "upstash-redis"
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function checkMemoryRateLimit(key, maxRequests, windowSec) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  let entry = MEMORY_RATE_LIMITS.get(key);
  if (!entry || now > entry.resetAt) {
    if (MEMORY_RATE_LIMITS.size >= MAX_MEM_BUCKETS) {
      const firstKey = MEMORY_RATE_LIMITS.keys().next().value;
      if (firstKey !== undefined) MEMORY_RATE_LIMITS.delete(firstKey);
    }
    entry = { count: 0, resetAt: now + windowMs };
  }
  entry.count += 1;
  MEMORY_RATE_LIMITS.set(key, entry);
  return {
    allowed: entry.count <= maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    limit: maxRequests,
    retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    backend: "memory-fallback"
  };
}

/**
 * Dual-key rate limiter (IP + Session).
 * Uses Upstash Redis when configured, falling back to in-memory per-instance limiter.
 */
async function enforceRateLimit(req, res, { scope = "api", maxRequests = 30, windowSec = 60 } = {}) {
  const ip = getClientIp(req);
  const session = getSessionId(req);
  const idHash = crypto.createHash("sha256").update(`${ip}|${session}`).digest("hex").slice(0, 20);
  const bucketKey = `aiv2:rl:${scope}:${idHash}`;

  const result =
    (await checkUpstashRateLimit(bucketKey, maxRequests, windowSec)) ||
    checkMemoryRateLimit(bucketKey, maxRequests, windowSec);

  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));

  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSec || windowSec));
    res.status(429).json({
      error: "Bạn đang gửi yêu cầu quá nhanh. Vui lòng đợi một lát rồi thử lại nhé!",
      code: "RATE_LIMITED"
    });
    return false;
  }
  return true;
}

/**
 * Validates actual image format via magic bytes (JPEG, PNG, WebP, GIF) and size cap.
 */
function validateImageBase64(rawInput) {
  if (typeof rawInput !== "string" || !rawInput.trim()) {
    return { valid: false, error: "Thiếu dữ liệu hình ảnh." };
  }
  if (rawInput.length > LIMITS.MAX_IMAGE_BASE64_CHARS) {
    return { valid: false, error: "Ảnh tải lên vượt quá giới hạn 4MB. Vui lòng chọn ảnh nhỏ hơn." };
  }

  let mime = "image/jpeg";
  let base64Body = rawInput.trim();

  const dataUrlMatch = base64Body.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (dataUrlMatch) {
    mime = dataUrlMatch[1].toLowerCase();
    base64Body = dataUrlMatch[2];
  }

  const allowedMimes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
  if (!allowedMimes.has(mime)) {
    return { valid: false, error: "Định dạng ảnh không được hỗ trợ (chỉ chấp nhận JPG, PNG, WebP, GIF)." };
  }

  const cleanB64 = base64Body.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(cleanB64)) {
    return { valid: false, error: "Dữ liệu ảnh base64 không hợp lệ." };
  }

  let buf;
  try {
    buf = Buffer.from(cleanB64, "base64");
  } catch (_) {
    return { valid: false, error: "Không thể giải mã dữ liệu ảnh." };
  }

  if (buf.length < 32) {
    return { valid: false, error: "Ảnh quá nhỏ hoặc bị hỏng." };
  }
  if (buf.length > LIMITS.MAX_IMAGE_BYTES) {
    return { valid: false, error: "Kích thước ảnh vượt quá 4MB." };
  }

  // Verify actual file magic bytes
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp =
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP";
  const isGif =
    buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a";

  if (!isJpeg && !isPng && !isWebp && !isGif) {
    return { valid: false, error: "Tệp tải lên không phải hình ảnh hợp lệ (sai chữ ký định dạng)." };
  }

  const detectedMime = isJpeg ? "image/jpeg" : isPng ? "image/png" : isWebp ? "image/webp" : "image/gif";
  return {
    valid: true,
    mime: detectedMime,
    bytes: buf.length,
    dataUrl: `data:${detectedMime};base64,${cleanB64}`
  };
}

function sanitizeText(str, maxLen = 500) {
  return String(str || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLen);
}

function sanitizeExternalUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const parsed = new URL(s);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return "";
  } catch (_) {
    return "";
  }
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return null;
    }
  }
  return {};
}

function validateChatMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return { valid: false, error: "Tin nhắn không được để trống." };
  }
  const cleaned = [];
  for (const m of messages.slice(-LIMITS.MAX_CHAT_HISTORY_ITEMS)) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = sanitizeText(m.content, LIMITS.MAX_CHAT_MESSAGE_CHARS);
    if (!content) continue;
    cleaned.push({ role, content });
  }
  if (!cleaned.length) {
    return { valid: false, error: "Nội dung tin nhắn không hợp lệ." };
  }
  return { valid: true, messages: cleaned };
}

module.exports = {
  LIMITS,
  getClientIp,
  getSessionId,
  applySecurityHeaders,
  enforceRateLimit,
  validateImageBase64,
  validateChatMessages,
  sanitizeText,
  sanitizeExternalUrl,
  parseJsonBody
};
