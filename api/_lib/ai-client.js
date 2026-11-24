/**
 * AIvolution 2.0 — Shared AI Provider Client (Groq Primary + OpenRouter Free Backup + Serper)
 * Preserves multi-key round-robin (up to 30 keys), cooldowns, timeouts, and single-flight caching.
 */

const crypto = require("crypto");

const AI_CONFIG = {
  GROQ_CHAT_PREFERRED: /llama-3\.3-70b|gpt-oss-120b|qwen3\.8|qwen-2\.5-32b/i,
  GROQ_CHAT_FALLBACK: /llama-3\.1|gpt-oss-20b|qwen/i,
  OPENROUTER_CHAT_MODELS: [
    "openrouter/free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3.5-lightning:free"
  ],
  KEY_COOLDOWN_429_MS: 45 * 1000,
  KEY_COOLDOWN_AUTH_MS: 10 * 60 * 1000,
  SERPER_CACHE_TTL_MS: 60 * 60 * 1000,
  MODELS_CACHE_TTL_MS: 20 * 60 * 1000
};

const state = {
  keyCooldownUntil: new Map(),
  rrIndex: Object.create(null),
  serperCache: new Map(),
  inFlight: new Map(),
  cachedGroqModels: null,
  cachedGroqModelsAt: 0
};

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(600, timeoutMs));
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function collectApiKeys(prefix) {
  const raw = [];
  if (process.env[prefix]) {
    raw.push(...String(process.env[prefix]).split(/[\s,;]+/));
  }
  for (let i = 1; i <= 30; i++) {
    const val = process.env[`${prefix}_${i}`];
    if (val) raw.push(...String(val).split(/[\s,;]+/));
  }
  const unique = [...new Set(raw.map((k) => k.trim()).filter(Boolean))];
  if (unique.length <= 1) return unique;

  const now = Date.now();
  const ready = unique.filter((k) => (state.keyCooldownUntil.get(k) || 0) <= now);
  const cooling = unique.filter((k) => (state.keyCooldownUntil.get(k) || 0) > now);

  if (ready.length > 1) {
    const idx = (state.rrIndex[prefix] || 0) % ready.length;
    state.rrIndex[prefix] = idx + 1;
    return [...ready.slice(idx), ...ready.slice(0, idx), ...cooling];
  }
  return [...ready, ...cooling];
}

function markKeyCooldown(apiKey, ms = AI_CONFIG.KEY_COOLDOWN_429_MS) {
  state.keyCooldownUntil.set(apiKey, Date.now() + ms);
}

function runSingleFlight(key, fn) {
  if (state.inFlight.has(key)) return state.inFlight.get(key);
  const p = Promise.resolve().then(fn).finally(() => state.inFlight.delete(key));
  state.inFlight.set(key, p);
  return p;
}

function extractJsonObject(rawText) {
  const cleaned = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/gi, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("INVALID_AI_JSON");
  }
  let jsonStr = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1").replace(/[\u0000-\u0019]+/g, " ");
    return JSON.parse(jsonStr);
  }
}

async function getWorkingGroqModels(apiKey, timeoutMs = 1500) {
  const now = Date.now();
  if (state.cachedGroqModels && now - state.cachedGroqModelsAt < AI_CONFIG.MODELS_CACHE_TTL_MS) {
    return state.cachedGroqModels;
  }
  return runSingleFlight("shared:groq:models", async () => {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${apiKey}` } },
      timeoutMs
    );
    if (!res.ok) throw new Error(`Groq models HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.data || [])
      .map((m) => m.id)
      .filter(
        (id) =>
          id &&
          !/whisper|tts|guard|safeguard|embed|prompt-guard|playai|orpheus|compound/i.test(id)
      );
    if (!models.length) throw new Error("No Groq models");
    state.cachedGroqModels = models;
    state.cachedGroqModelsAt = Date.now();
    return models;
  });
}

async function generateTextCompletion({
  messages,
  temperature = 0.3,
  maxTokens = 1200,
  timeoutMs = 7500
}) {
  const groqKeys = collectApiKeys("GROQ_API_KEY");
  const openRouterKeys = collectApiKeys("OPENROUTER_API_KEY");

  if (!groqKeys.length && !openRouterKeys.length) {
    const err = new Error("MISSING_AI_KEYS");
    err.code = "MISSING_AI_KEYS";
    throw err;
  }

  // 1. Groq Primary
  for (const apiKey of groqKeys.slice(0, 2)) {
    try {
      const models = await getWorkingGroqModels(apiKey);
      const sorted = [
        ...models.filter((m) => AI_CONFIG.GROQ_CHAT_PREFERRED.test(m)),
        ...models.filter((m) => AI_CONFIG.GROQ_CHAT_FALLBACK.test(m))
      ];
      for (const model of [...new Set(sorted)].slice(0, 2)) {
        const payload = {
          model,
          temperature,
          max_completion_tokens: maxTokens,
          messages
        };
        if (/qwen3/i.test(model)) payload.reasoning_effort = "none";

        const res = await fetchWithTimeout(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
          },
          timeoutMs
        );
        if (res.status === 429) {
          markKeyCooldown(apiKey, AI_CONFIG.KEY_COOLDOWN_429_MS);
          break;
        }
        if (res.status === 401 || res.status === 403) {
          markKeyCooldown(apiKey, AI_CONFIG.KEY_COOLDOWN_AUTH_MS);
          break;
        }
        if (!res.ok) continue;
        const data = await res.json();
        const text = String(data.choices?.[0]?.message?.content || "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim();
        if (text) return { text, provider: `groq:${model}` };
      }
    } catch (_) {
      continue;
    }
  }

  // 2. OpenRouter Backup
  for (const model of AI_CONFIG.OPENROUTER_CHAT_MODELS) {
    for (const apiKey of openRouterKeys.slice(0, 2)) {
      try {
        const res = await fetchWithTimeout(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "HTTP-Referer": "https://aitl-teal.vercel.app",
              "X-Title": "AIvolution"
            },
            body: JSON.stringify({
              model,
              temperature,
              max_tokens: maxTokens,
              reasoning: { enabled: false },
              provider: { sort: "throughput" },
              messages
            })
          },
          timeoutMs
        );
        if (res.status === 429) {
          markKeyCooldown(apiKey, AI_CONFIG.KEY_COOLDOWN_429_MS);
          break;
        }
        if (!res.ok) continue;
        const data = await res.json();
        const msgObj = data.choices?.[0]?.message || {};
        const text = String(msgObj.content || msgObj.reasoning || "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim();
        if (text) return { text, provider: `openrouter:${model}` };
      } catch (_) {
        continue;
      }
    }
  }

  const err = new Error("AI_UNAVAILABLE");
  err.code = "AI_UNAVAILABLE";
  throw err;
}

async function querySerper(query, { type = "search", num = 5, timeoutMs = 2000, extra = {} } = {}) {
  const apiKeys = collectApiKeys("SERPER_API_KEY");
  if (!apiKeys.length || !query) return null;

  const cacheKey = crypto
    .createHash("sha256")
    .update(`${type}|${query}|${num}|${JSON.stringify(extra)}`)
    .digest("hex")
    .slice(0, 24);

  const cached = state.serperCache.get(cacheKey);
  if (cached && Date.now() < cached.exp) return cached.val;

  return runSingleFlight(`serper:${cacheKey}`, async () => {
    const endpoint = type === "maps" ? "https://google.serper.dev/maps" : "https://google.serper.dev/search";
    for (const apiKey of apiKeys.slice(0, 2)) {
      try {
        const res = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: {
              "X-API-KEY": apiKey,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ q: query, gl: "vn", hl: "vi", num, ...extra })
          },
          timeoutMs
        );
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          markKeyCooldown(apiKey, AI_CONFIG.KEY_COOLDOWN_AUTH_MS);
          continue;
        }
        if (!res.ok) continue;
        const data = await res.json();
        if (state.serperCache.size >= 200) {
          const oldest = state.serperCache.keys().next().value;
          if (oldest !== undefined) state.serperCache.delete(oldest);
        }
        state.serperCache.set(cacheKey, { val: data, exp: Date.now() + AI_CONFIG.SERPER_CACHE_TTL_MS });
        return data;
      } catch (_) {
        continue;
      }
    }
    return null;
  });
}

function getServiceStatus() {
  return {
    groqConfigured: collectApiKeys("GROQ_API_KEY").length > 0,
    openRouterConfigured: collectApiKeys("OPENROUTER_API_KEY").length > 0,
    serperConfigured: collectApiKeys("SERPER_API_KEY").length > 0,
    redisRateLimitConfigured: Boolean(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    )
  };
}

module.exports = {
  fetchWithTimeout,
  collectApiKeys,
  markKeyCooldown,
  runSingleFlight,
  extractJsonObject,
  generateTextCompletion,
  querySerper,
  getServiceStatus
};
