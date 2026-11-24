/**
 * AIvolution 2.0 — Unified Smart Search API (/api/search)
 * Searches places, foods, products, and services across Serper Google Search/Maps
 * and Wikipedia Vietnam, with AI natural-language summary when available.
 */

const {
  LIMITS,
  applySecurityHeaders,
  enforceRateLimit,
  sanitizeText,
  sanitizeExternalUrl
} = require("./_lib/security");
const { fetchWithTimeout, querySerper } = require("./_lib/ai-client");

async function searchWikipediaVi(query) {
  try {
    const url =
      `https://vi.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
      `&srlimit=5&utf8=1&format=json`;
    const res = await fetchWithTimeout(url, {}, 2600);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.query?.search || []).map((item) => ({
      type: "knowledge",
      sourceType: "realtime",
      title: item.title,
      snippet: String(item.snippet || "").replace(/<[^>]+>/g, "").slice(0, 160),
      badge: "Wikipedia",
      url: `https://vi.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`
    }));
  } catch (_) {
    return [];
  }
}

module.exports = async (req, res) => {
  applySecurityHeaders(req, res);
  res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=360");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Phương thức không được hỗ trợ." });

  if (!(await enforceRateLimit(req, res, { scope: "search", maxRequests: 30, windowSec: 60 }))) return;

  const q = sanitizeText(req.query?.q, LIMITS.MAX_SEARCH_QUERY_CHARS);
  if (!q || q.length < 2) {
    return res.status(400).json({ error: "Vui lòng nhập ít nhất 2 ký tự để tìm kiếm." });
  }

  const scopedQuery = /đà nẵng|hội an|việt nam/i.test(q) ? q : `${q} Đà Nẵng Hội An`;

  try {
    const [serperRes, wikiRes] = await Promise.all([
      querySerper(scopedQuery, { num: 6, timeoutMs: 2400 }),
      searchWikipediaVi(q)
    ]);

    const webResults = (serperRes?.organic || [])
      .map((item) => {
        const url = sanitizeExternalUrl(item.link);
        if (!url) return null;
        return {
          type: "web",
          sourceType: "realtime",
          title: sanitizeText(item.title, 120),
          snippet: sanitizeText(item.snippet, 180),
          badge: "Google Search",
          url
        };
      })
      .filter(Boolean);

    const mapsQuickItem = {
      type: "maps",
      sourceType: "realtime",
      title: `Tìm "${q}" trên Google Maps`,
      snippet: "Mở Google Maps để xem địa chỉ, đánh giá và chỉ đường thực tế.",
      badge: "Google Maps",
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(scopedQuery)}`
    };

    return res.status(200).json({
      query: q,
      results: [mapsQuickItem, ...webResults, ...wikiRes].slice(0, 12),
      serperUsed: webResults.length > 0,
      updatedAt: Date.now()
    });
  } catch (_) {
    return res.status(502).json({ error: "Không thể thực hiện tìm kiếm lúc này." });
  }
};
