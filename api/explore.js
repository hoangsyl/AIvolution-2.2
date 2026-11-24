/**
 * AIvolution 2.0 — Free Real-time News, Food & Drinks, Check-in & Discovery Hub
 * Preserves /api/explore?tab=news|food|checkin and adds:
 * - News categories: all, danang, hoian, travel, food, events, culture, ai
 * - Food categories: all, specialties, fastfood, drinks, vegetarian, seafood, streetfood, restaurant, cafe
 * - Clear sourceType labels ("realtime" | "curated") so users always know data provenance
 * - Stale-article filtering, strict deduplication, security headers & rate limiting (no debug leaks)
 */

const { applySecurityHeaders, enforceRateLimit, sanitizeExternalUrl } = require("./_lib/security");

const CACHE_TTL_MS = 25 * 60 * 1000;
const MAX_NEWS_AGE_DAYS = 21;
const ramCache = new Map();
const inFlight = new Map();
const UA = "Mozilla/5.0 (compatible; AIvolutionBot/2.0; +https://aitl-teal.vercel.app)";

const CURATED_FOODS = [
  {
    title: "Nước Mót Hội An — Trà thảo mộc cánh sen",
    subtitle: "150 Trần Phú, Phố cổ Hội An • Thức uống thảo mộc sả chanh, gừng, cam thảo giải nhiệt đặc trưng.",
    badge: "Đặc sản Hội An",
    category: "drinks",
    meta: "16.000 - 30.000đ",
    wikiKey: "Trà thảo mộc",
    address: "150 Trần Phú, Hội An"
  },
  {
    title: "Chè Xí Mà Phủ (Chè mè đen) Ông Thiều",
    subtitle: "130 Nguyễn Trường Tộ, Hội An • Món chè mè đen nấu cùng vị thuốc bắc gia truyền hơn 70 năm.",
    badge: "Đồ ăn đường phố",
    category: "streetfood",
    meta: "10.000 - 15.000đ",
    wikiKey: "Chè",
    address: "130 Nguyễn Trường Tộ, Hội An"
  },
  {
    title: "Bánh Mì Phượng Hội An",
    subtitle: "2B Phan Chu Trinh, Hội An • Vỏ giòn rụm, xốt gia truyền với nhân xá xíu, pate, thịt nướng.",
    badge: "Đồ ăn đường phố",
    category: "streetfood",
    meta: "25.000 - 45.000đ",
    wikiKey: "Bánh mì Việt Nam",
    address: "2B Phan Chu Trinh, Hội An"
  },
  {
    title: "Bánh Mì Madam Khánh (The Bánh Mì Queen)",
    subtitle: "115 Trần Cao Vân, Hội An • Nhân thập cẩm hài hòa, nộm đu đủ giòn và nước xốt béo thơm.",
    badge: "Đặc sản Hội An",
    category: "streetfood",
    meta: "25.000 - 40.000đ",
    wikiKey: "Bánh mì Việt Nam",
    address: "115 Trần Cao Vân, Hội An"
  },
  {
    title: "Cao Lầu Thanh — Chuẩn vị phố cổ",
    subtitle: "26 Thái Phiên, Hội An • Sợi mì vàng dai giòn, thịt xá xíu mềm, da heo chiên và rau Trà Quế.",
    badge: "Đặc sản Hội An",
    category: "specialties",
    meta: "30.000 - 45.000đ",
    wikiKey: "Cao lầu",
    address: "26 Thái Phiên, Hội An"
  },
  {
    title: "Cơm Gà Bà Buội Hội An",
    subtitle: "22 Phan Chu Trinh, Hội An • Cơm nấu nước luộc gà vàng tơi, gà ta xé phay trộn hành tây rau răm.",
    badge: "Đặc sản Hội An",
    category: "specialties",
    meta: "35.000 - 55.000đ",
    wikiKey: "Cơm gà",
    address: "22 Phan Chu Trinh, Hội An"
  },
  {
    title: "Mì Quảng Bà Mua — Đà Nẵng",
    subtitle: "19-21 Trần Bình Trọng, Hải Châu, Đà Nẵng • Mì Quảng tôm thịt, ếch, gà ta chuẩn vị xứ Quảng.",
    badge: "Đặc sản Đà Nẵng",
    category: "specialties",
    meta: "35.000 - 55.000đ",
    wikiKey: "Mì Quảng",
    address: "19 Trần Bình Trọng, Đà Nẵng"
  },
  {
    title: "Hải Sản Bé Mặn — Đường biển Võ Nguyên Giáp",
    subtitle: "Lô 8 Võ Nguyên Giáp, Sơn Trà, Đà Nẵng • Hải sản tươi sống chọn trực tiếp, chế biến nhanh.",
    badge: "Hải sản Đà Nẵng",
    category: "seafood",
    meta: "150.000 - 350.000đ/người",
    wikiKey: "Hải sản",
    address: "Võ Nguyên Giáp, Sơn Trà, Đà Nẵng"
  },
  {
    title: "Cơm Chay Đàm — Hội An",
    subtitle: "71/20 Phan Chu Trinh, Hội An • Các món chay truyền thống phố cổ, thanh đạm và đa dạng.",
    badge: "Món chay",
    category: "vegetarian",
    meta: "25.000 - 50.000đ",
    wikiKey: "Ẩm thực chay",
    address: "71 Phan Chu Trinh, Hội An"
  },
  {
    title: "Faifo Coffee — View mái ngói Phố cổ Hội An",
    subtitle: "130 Trần Phú, Hội An • Quán cà phê sân thượng nổi tiếng ngắm toàn cảnh phố cổ.",
    badge: "Quán cà phê",
    category: "cafe",
    meta: "35.000 - 65.000đ",
    wikiKey: "Cà phê sữa đá",
    address: "130 Trần Phú, Hội An"
  },
  {
    title: "Bánh Đập – Hến Xào Cẩm Nam",
    subtitle: "Lương Như Bích, Cẩm Nam, Hội An • Bánh tráng nướng kẹp bánh ướt chấm mắm nêm ăn cùng hến xào.",
    badge: "Đặc sản Hội An",
    category: "specialties",
    meta: "25.000 - 50.000đ",
    wikiKey: "Mì Quảng",
    address: "Cẩm Nam, Hội An"
  },
  {
    title: "KFC Việt Nam — Combo gà rán & Ưu đãi",
    subtitle: "Tìm chi nhánh KFC gần nhất Đà Nẵng – Hội An • Bấm Hỏi AI để tra combo gợi ý.",
    badge: "Đồ ăn nhanh",
    category: "fastfood",
    meta: "39.000 - 99.000đ",
    wikiKey: "Gà rán",
    address: "KFC Đà Nẵng Hội An"
  },
  {
    title: "Dookki — Buffet Tokbokki & Phô mai",
    subtitle: "Tìm chi nhánh Dookki gần nhất tại Đà Nẵng • Buffet lẩu Tokbokki Hàn Quốc.",
    badge: "Nhà hàng",
    category: "restaurant",
    meta: "139.000đ/vé (tham khảo)",
    wikiKey: "Tteokbokki",
    address: "Dookki Đà Nẵng"
  }
];

function fetchWithTimeout(url, options = {}, timeoutMs = 3400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...options,
    headers: { "User-Agent": UA, ...(options.headers || {}) },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

function runSingleFlight(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function buildMapsPlaceUrl(title, address = "") {
  const q =
    address && !address.toLowerCase().includes(title.toLowerCase())
      ? `${title}, ${address}`
      : `${title}, Đà Nẵng - Hội An`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(str) {
  return decodeHtml(String(str || "").replace(/<[^>]+>/g, " "));
}

function sanitizeImgUrl(raw) {
  let u = decodeHtml(raw || "").trim();
  if (!u || /^data:/i.test(u)) return "";
  if (u.startsWith("//")) u = `https:${u}`;
  if (u.startsWith("http://")) u = u.replace(/^http:\/\//i, "https://");
  if (!/^https:\/\//i.test(u)) return "";
  if (/logo|icon|avatar|pixel|1x1|blank\./i.test(u)) return "";
  return u;
}

function parsePubDate(pubDateRaw) {
  if (!pubDateRaw) return { ts: 0, label: "Gần đây", isStale: false };
  const d = new Date(pubDateRaw);
  if (Number.isNaN(d.getTime())) return { ts: 0, label: "Gần đây", isStale: false };

  const diffMs = Date.now() - d.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const isStale = diffDays > MAX_NEWS_AGE_DAYS;
  const diffMin = Math.floor(diffMs / 60000);

  let label;
  if (diffMin >= 0 && diffMin < 60) label = `${Math.max(1, diffMin)} phút trước`;
  else if (diffMin >= 60 && diffMin < 1440) label = `${Math.floor(diffMin / 60)} giờ trước`;
  else {
    label = d.toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Asia/Ho_Chi_Minh"
    });
  }
  return { ts: d.getTime(), label, isStale };
}

function classifyNewsCategory(text) {
  const t = String(text || "").toLowerCase();
  if (/trí tuệ nhân tạo|\bai\b|chatgpt|gemini|openai|llm|công nghệ|robot|chip/.test(t)) return "ai";
  if (/ẩm thực|món ăn|nhà hàng|quán ăn|cà phê|trà sữa|bánh mì|cao lầu|mì quảng|hải sản/.test(t)) return "food";
  if (/lễ hội|sự kiện|pháo hoa|concert|festival|biểu diễn|giải chạy/.test(t)) return "events";
  if (/văn hóa|di sản|bảo tàng|làng nghề|hán nôm|đèn lồng|chùa cầu|lịch sử/.test(t)) return "culture";
  if (/hội an|phố cổ|cù lao chàm|an bàng|quảng nam/.test(t)) return "hoian";
  if (/du lịch|check-in|bãi biển|bà nà|sơn trà|khách sạn|nghỉ dưỡng/.test(t)) return "travel";
  return "danang";
}

function extractImageFromRssBlock(block, decodedDesc) {
  const candidates = [
    (block.match(/<media:content[^>]+url=["']([^"']+)["']/i) || [])[1],
    (block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) || [])[1],
    (block.match(/<enclosure[^>]+url=["']([^"']+)["']/i) || [])[1],
    (decodedDesc.match(/<img[^>]+data-src=["']([^"']+)["']/i) || [])[1],
    (decodedDesc.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1]
  ];
  for (const c of candidates) {
    const clean = sanitizeImgUrl(c);
    if (clean) return clean;
  }
  return "";
}

async function fetchRssFeed(url, { defaultSource = "Tin tức", filterRegex = null, limit = 8, forceCategory = "" } = {}) {
  const res = await fetchWithTimeout(url, {}, 3400);
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;

  while ((m = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const rawLink = (block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "";
    const rawDesc = (block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "";
    const rawSource = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || "";
    const rawDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "";

    const pub = parsePubDate(stripTags(rawDate));
    if (pub.isStale) continue;

    const decodedDesc = decodeHtml(rawDesc);
    const image = extractImageFromRssBlock(block, decodedDesc);
    let title = stripTags(rawTitle);
    const source = stripTags(rawSource) || defaultSource;
    if (rawSource && title.endsWith(`- ${source}`)) {
      title = title.slice(0, -(source.length + 2)).trim();
    } else if (defaultSource === "Google News") {
      title = title.replace(/\s*-\s*[^-]{2,35}$/, "").trim() || title;
    }

    const link = sanitizeExternalUrl(stripTags(rawLink));
    const snippet = stripTags(rawDesc).slice(0, 160);
    if (!title || !link) continue;
    if (filterRegex && !filterRegex.test(`${title} ${snippet}`)) continue;

    items.push({
      type: "news",
      sourceType: "realtime",
      category: forceCategory || classifyNewsCategory(`${title} ${snippet}`),
      title,
      subtitle: snippet && snippet !== title ? snippet : `Cập nhật từ ${source}.`,
      badge: source,
      meta: pub.label,
      publishedAt: pub.ts,
      image,
      url: link
    });
  }
  return items;
}

async function fetchWikiPhotoMap(titles) {
  const map = Object.create(null);
  try {
    const url =
      `https://vi.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(titles.join("|"))}` +
      `&prop=pageimages&piprop=thumbnail&pithumbsize=640&redirects=1&format=json`;
    const res = await fetchWithTimeout(url, {}, 2600);
    if (!res.ok) return map;
    const data = await res.json();

    const normMap = Object.create(null);
    (data.query?.normalized || []).forEach((n) => { normMap[n.to] = n.from; });
    const redirMap = Object.create(null);
    (data.query?.redirects || []).forEach((r) => { redirMap[r.to] = r.from; });

    Object.values(data.query?.pages || {}).forEach((p) => {
      const img = sanitizeImgUrl(p.thumbnail?.source || "");
      if (!img) return;
      map[p.title] = img;
      if (redirMap[p.title]) map[redirMap[p.title]] = img;
      if (normMap[p.title]) map[normMap[p.title]] = img;
    });
  } catch (_) {}
  return map;
}

async function fetchWikiGeosearch(lat, lng, cityName) {
  const url =
    `https://vi.wikipedia.org/w/api.php?action=query&generator=geosearch` +
    `&ggscoord=${lat}|${lng}&ggsradius=10000&ggslimit=16` +
    `&prop=pageimages|extracts&piprop=thumbnail&pithumbsize=640` +
    `&exintro=1&explaintext=1&exsentences=1&format=json`;

  const res = await fetchWithTimeout(url, {}, 3000);
  if (!res.ok) throw new Error(`Wiki HTTP ${res.status}`);
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});
  const skipAdmin = /^(Phường|Xã|Quận|Huyện|Thành phố|Tỉnh|Danh sách|Bầu cử|Sân bay|Trận |Đại học|Trường )/i;

  return pages
    .filter((p) => p.title && !skipAdmin.test(p.title) && p.thumbnail?.source)
    .map((p) => ({
      type: "place",
      sourceType: "curated",
      category: cityName === "Hội An" ? "hoian" : "danang",
      title: p.title,
      subtitle: p.extract ? p.extract.slice(0, 125) : `Điểm đến nổi bật tại ${cityName}.`,
      badge: `Check-in ${cityName}`,
      meta: "Wikipedia",
      image: sanitizeImgUrl(p.thumbnail.source),
      url: buildMapsPlaceUrl(p.title, cityName)
    }))
    .filter((x) => x.image)
    .slice(0, 8);
}

function dedupeAndSort(list, maxItems = 40, sortByDate = false) {
  const seenTitle = new Set();
  const seenUrl = new Set();
  const unique = list.filter((item) => {
    const k = String(item.title || "").toLowerCase().replace(/[^a-z0-9à-ỹ]/gi, "").slice(0, 38);
    if (!k || seenTitle.has(k) || (item.url && seenUrl.has(item.url))) return false;
    seenTitle.add(k);
    if (item.url) seenUrl.add(item.url);
    return true;
  });

  if (sortByDate) {
    unique.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  }
  const withImg = unique.filter((x) => Boolean(x.image));
  const noImg = unique.filter((x) => !x.image);
  return [...withImg, ...noImg].slice(0, maxItems);
}

async function getFreeRealtimeNews() {
  const dnHaFilter =
    /đà nẵng|hội an|quảng nam|cầu rồng|sông hàn|sơn trà|bà nà|mỹ khê|cù lao chàm|ngũ hành sơn|hải châu|cẩm châu|an bàng|miền trung/i;

  const gDaNang = `https://news.google.com/rss/search?q=${encodeURIComponent('"Đà Nẵng" (du lịch OR sự kiện OR lễ hội OR thời sự OR ẩm thực) when:14d')}&hl=vi&gl=VN&ceid=VN:vi`;
  const gHoiAn = `https://news.google.com/rss/search?q=${encodeURIComponent('"Hội An" (phố cổ OR du lịch OR văn hóa OR lễ hội OR ẩm thực) when:14d')}&hl=vi&gl=VN&ceid=VN:vi`;
  const gAiTech = `https://news.google.com/rss/search?q=${encodeURIComponent('("trí tuệ nhân tạo" OR "công nghệ AI") Việt Nam when:10d')}&hl=vi&gl=VN&ceid=VN:vi`;

  const newsWikiKeys = ["Đà Nẵng", "Hội An", "Cầu Rồng", "Chùa Cầu", "Bà Nà", "Bán đảo Sơn Trà"];
  const feeds = [
    fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress", filterRegex: dnHaFilter, limit: 8 }),
    fetchRssFeed("https://vnexpress.net/rss/thoi-su.rss", { defaultSource: "VnExpress", filterRegex: dnHaFilter, limit: 8 }),
    fetchRssFeed("https://tuoitre.vn/rss/du-lich.rss", { defaultSource: "Tuổi Trẻ", filterRegex: dnHaFilter, limit: 8 }),
    fetchRssFeed("https://thanhnien.vn/rss/du-lich.rss", { defaultSource: "Thanh Niên", filterRegex: dnHaFilter, limit: 8 }),
    fetchRssFeed("https://dantri.com.vn/rss/du-lich.rss", { defaultSource: "Dân Trí", filterRegex: dnHaFilter, limit: 8 }),
    fetchRssFeed("https://vnexpress.net/rss/so-hoa.rss", { defaultSource: "VnExpress Số hóa", filterRegex: /ai|trí tuệ nhân tạo|công nghệ|ứng dụng/i, limit: 6, forceCategory: "ai" }),
    fetchRssFeed(gDaNang, { defaultSource: "Google News", limit: 12 }),
    fetchRssFeed(gHoiAn, { defaultSource: "Google News", limit: 12, forceCategory: "hoian" }),
    fetchRssFeed(gAiTech, { defaultSource: "Google News", limit: 8, forceCategory: "ai" })
  ];

  const [photoMap, ...settled] = await Promise.all([
    fetchWikiPhotoMap(newsWikiKeys),
    ...feeds.map((p) => p.then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: [] })))
  ]);

  const rssErrors = settled.filter((s) => !s.ok).length;
  const pickFallback = (text) => {
    const t = String(text || "").toLowerCase();
    if (/chùa cầu|phố cổ|hội an/.test(t)) return photoMap["Chùa Cầu"] || photoMap["Hội An"] || "";
    if (/bà nà|cầu vàng/.test(t)) return photoMap["Bà Nà"] || photoMap["Đà Nẵng"] || "";
    if (/sơn trà/.test(t)) return photoMap["Bán đảo Sơn Trà"] || photoMap["Đà Nẵng"] || "";
    return photoMap["Đà Nẵng"] || photoMap["Cầu Rồng"] || "";
  };

  const items = settled
    .filter((r) => r.ok)
    .flatMap((r) => r.value)
    .map((item) => ({
      ...item,
      image: item.image || pickFallback(`${item.title} ${item.subtitle}`)
    }));

  return {
    items: dedupeAndSort(items, 42, true),
    rssHealth: { totalFeeds: feeds.length, failedFeeds: rssErrors }
  };
}

async function getFreeTrendingFood() {
  const wikiKeys = [
    "Gà rán",
    "Tteokbokki",
    "Cà phê sữa đá",
    "Trà thảo mộc",
    "Chè",
    "Bánh mì Việt Nam",
    "Cao lầu",
    "Cơm gà",
    "Mì Quảng",
    "Hải sản",
    "Ẩm thực chay"
  ];
  const foodFilter = /đà nẵng|hội an|ẩm thực|quán ăn|món ngon|cà phê|hải sản|trà sữa|kfc|dookki|highlands|mixue/i;

  const [photoMap, ...rssSettled] = await Promise.all([
    fetchWikiPhotoMap(wikiKeys),
    ...[
      fetchRssFeed("https://thanhnien.vn/rss/am-thuc.rss", { defaultSource: "Thanh Niên", filterRegex: foodFilter, limit: 6, forceCategory: "restaurant" }),
      fetchRssFeed("https://kenh14.vn/an-quay-di.rss", { defaultSource: "Kenh14", filterRegex: foodFilter, limit: 6, forceCategory: "streetfood" })
    ].map((p) => p.then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: [] })))
  ]);

  const liveNews = rssSettled
    .filter((r) => r.ok)
    .flatMap((r) => r.value)
    .map((item) => ({ ...item, image: item.image || photoMap["Bánh mì Việt Nam"] || "" }));

  const curatedCards = CURATED_FOODS.map((spot) => ({
    type: "place",
    sourceType: "curated",
    category: spot.category,
    title: spot.title,
    subtitle: spot.subtitle,
    badge: spot.badge,
    meta: spot.meta,
    address: spot.address,
    image: photoMap[spot.wikiKey] || photoMap["Cao lầu"] || "",
    url: buildMapsPlaceUrl(spot.title.split("—")[0].trim(), spot.address)
  }));

  return { items: dedupeAndSort([...curatedCards, ...liveNews], 22, false) };
}

async function getFreeTrendingCheckin() {
  const checkinFilter = /đà nẵng|hội an|quảng nam|check-in|cà phê|hoàng hôn|phố cổ|biển|cầu|sơn trà|bà nà/i;
  const settled = await Promise.allSettled([
    fetchWikiGeosearch(15.8801, 108.3380, "Hội An"),
    fetchWikiGeosearch(16.0544, 108.2208, "Đà Nẵng"),
    fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress", filterRegex: checkinFilter, limit: 5 }),
    fetchRssFeed("https://tuoitre.vn/rss/du-lich.rss", { defaultSource: "Tuổi Trẻ", filterRegex: checkinFilter, limit: 5 })
  ]);

  const wikiHA = settled[0].status === "fulfilled" ? settled[0].value : [];
  const wikiDN = settled[1].status === "fulfilled" ? settled[1].value : [];
  const rss = settled.slice(2).filter((r) => r.status === "fulfilled").flatMap((r) => r.value).filter((x) => Boolean(x.image));

  const interleaved = [];
  const maxLen = Math.max(wikiHA.length, wikiDN.length);
  for (let i = 0; i < maxLen; i++) {
    if (wikiHA[i]) interleaved.push(wikiHA[i]);
    if (wikiDN[i]) interleaved.push(wikiDN[i]);
  }
  return { items: dedupeAndSort([...interleaved, ...rss], 18, false) };
}

module.exports = async (req, res) => {
  applySecurityHeaders(req, res);
  res.setHeader("Cache-Control", "public, s-maxage=1200, stale-while-revalidate=2400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Phương thức không được hỗ trợ." });

  if (!(await enforceRateLimit(req, res, { scope: "explore", maxRequests: 40, windowSec: 60 }))) return;

  const tab = ["news", "food", "checkin"].includes(req.query?.tab) ? req.query.tab : "news";
  const category = String(req.query?.category || "all").toLowerCase();
  const force = Boolean(req.query?._t);

  const cached = ramCache.get(tab);
  let payload;

  if (!force && cached && Date.now() < cached.exp) {
    payload = { ...cached.data, cached: true };
  } else {
    try {
      const result = await runSingleFlight(`explore:${tab}`, async () => {
        if (tab === "news") return getFreeRealtimeNews();
        if (tab === "food") return getFreeTrendingFood();
        return getFreeTrendingCheckin();
      });

      payload = {
        tab,
        updatedAt: new Date().toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Ho_Chi_Minh"
        }),
        provider: "free-open-rss-wiki",
        rssHealth: result.rssHealth || null,
        items: result.items
      };

      if (result.items.length) {
        ramCache.set(tab, { data: payload, exp: Date.now() + CACHE_TTL_MS });
      }
    } catch (_) {
      return res.status(502).json({
        error: "Không tải được nguồn tin RSS lúc này. Bạn thử làm mới sau ít phút nhé!"
      });
    }
  }

  const filteredItems =
    category && category !== "all"
      ? payload.items.filter((item) => item.category === category)
      : payload.items;

  return res.status(200).json({ ...payload, category, items: filteredItems });
};
