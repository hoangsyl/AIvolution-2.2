/**
 * AIvolution 2.0 — Smart Explore Map & Nearby Places API
 * Preserves /api/nearby-places contract, expands radius up to 10km (500m..10km),
 * supports 8+ categories, keyword search, rating filter, and OpenStreetMap Overpass
 * fallback when SERPER_API_KEY is not configured.
 */

const { applySecurityHeaders, enforceRateLimit, sanitizeText } = require("./_lib/security");
const { fetchWithTimeout, collectApiKeys } = require("./_lib/ai-client");

const QUERY_MAP = {
  all: "nhà hàng quán ăn cafe khách sạn điểm du lịch minimart siêu thị hiệu thuốc ATM",
  food: "nhà hàng quán ăn ngon đặc sản",
  restaurant: "nhà hàng quán ăn ngon",
  cafe: "quán cà phê trà sữa coffee",
  hotel: "khách sạn homestay resort",
  tourism: "địa điểm du lịch tham quan bảo tàng bãi biển",
  minimart: "minimart siêu thị tiện lợi bách hóa xanh winmart",
  atm: "ATM ngân hàng rút tiền",
  pharmacy: "nhà thuốc hiệu thuốc pharmacity long châu"
};

const OSM_TAG_MAP = {
  all: '["amenity"~"restaurant|cafe|fast_food|pharmacy|atm|bank"]',
  food: '["amenity"~"restaurant|fast_food|food_court"]',
  restaurant: '["amenity"="restaurant"]',
  cafe: '["amenity"="cafe"]',
  hotel: '["tourism"~"hotel|hostel|guest_house|resort"]',
  tourism: '["tourism"~"attraction|museum|viewpoint|artwork"]',
  minimart: '["shop"~"convenience|supermarket"]',
  atm: '["amenity"~"atm|bank"]',
  pharmacy: '["amenity"="pharmacy"]'
};

function calcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function fetchOsmFallback(lat, lng, radius, category, keyword) {
  const cappedRadius = Math.min(radius, 5000);
  const tagFilter = OSM_TAG_MAP[category] || OSM_TAG_MAP.all;
  const query = `[out:json][timeout:6];(node${tagFilter}(around:${cappedRadius},${lat},${lng});way${tagFilter}(around:${cappedRadius},${lat},${lng}););out center 25;`;

  const res = await fetchWithTimeout(
    "https://overpass-api.de/api/interpreter",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`
    },
    5500
  );
  if (!res.ok) throw new Error("OSM unavailable");
  const data = await res.json();
  const kwLower = keyword.toLowerCase();

  return (data.elements || [])
    .map((el) => {
      const pLat = el.lat ?? el.center?.lat;
      const pLng = el.lon ?? el.center?.lon;
      const tags = el.tags || {};
      const name = tags.name || tags["name:vi"] || "";
      if (!name || !Number.isFinite(pLat) || !Number.isFinite(pLng)) return null;
      if (kwLower && !name.toLowerCase().includes(kwLower)) return null;
      const addrParts = [tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"], tags["addr:city"]].filter(Boolean);
      return {
        id: `osm_${el.type}_${el.id}`,
        name,
        type: tags.cuisine || tags.amenity || tags.tourism || tags.shop || "Địa điểm",
        address: addrParts.join(", "),
        rating: 0,
        reviews: 0,
        lat: pLat,
        lng: pLng,
        distance: calcDistanceMeters(lat, lng, pLat, pLng),
        source: "OpenStreetMap",
        mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${pLat},${pLng}`
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 25);
}

module.exports = async (req, res) => {
  applySecurityHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Phương thức không được hỗ trợ." });
  }

  if (!(await enforceRateLimit(req, res, { scope: "nearby", maxRequests: 30, windowSec: 60 }))) return;

  const lat = Number(req.query?.lat);
  const lng = Number(req.query?.lng);
  const radius = Math.min(Math.max(Number(req.query?.radius) || 1000, 500), 10000);
  const category = QUERY_MAP[req.query?.category] ? req.query.category : "all";
  const minRating = Math.min(Math.max(Number(req.query?.minRating) || 0, 0), 5);
  const keyword = sanitizeText(req.query?.q, 80);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: "Tọa độ GPS không hợp lệ." });
  }

  const serperKeys = collectApiKeys("SERPER_API_KEY");
  const apiKey = serperKeys[0];

  if (!apiKey) {
    try {
      const osmPlaces = await fetchOsmFallback(lat, lng, radius, category, keyword);
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json({
        places: osmPlaces,
        radius,
        category,
        provider: "openstreetmap-fallback",
        notice: "Đang dùng dữ liệu OpenStreetMap (chưa có xếp hạng sao). Thêm SERPER_API_KEY trên Vercel để lấy đánh giá Google Maps.",
        updatedAt: Date.now()
      });
    } catch (_) {
      return res.status(503).json({
        error: "Chưa cấu hình SERPER_API_KEY trên Vercel và OpenStreetMap đang tạm bận.",
        code: "MISSING_API_KEY",
        missingEnv: ["SERPER_API_KEY"]
      });
    }
  }

  try {
    const zoom = radius <= 1000 ? "15z" : radius <= 3000 ? "14z" : radius <= 5000 ? "13z" : "12z";
    const searchQuery = keyword ? `${keyword} ${category !== "all" ? QUERY_MAP[category] : ""}`.trim() : QUERY_MAP[category];

    const response = await fetchWithTimeout(
      "https://google.serper.dev/maps",
      {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          q: searchQuery,
          ll: `@${lat},${lng},${zoom}`,
          gl: "vn",
          hl: "vi"
        })
      },
      4500
    );

    if (!response.ok) {
      return res.status(502).json({ error: "Không thể kết nối dữ liệu Google Maps lúc này." });
    }

    const data = await response.json();
    const seen = new Set();
    const effectiveMinRating = minRating > 0 ? minRating : (category === "atm" || category === "pharmacy" ? 0 : 3.8);

    const places = (data.places || [])
      .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .map((p) => {
        const id = p.cid || `${p.latitude}_${p.longitude}`;
        const distance = calcDistanceMeters(lat, lng, p.latitude, p.longitude);
        return {
          id,
          name: p.title || "Địa điểm chưa rõ tên",
          type: p.type || "Địa điểm",
          address: p.address || "",
          phone: p.phoneNumber || "",
          rating: Number(p.rating) || 0,
          reviews: Number(p.ratingCount) || 0,
          lat: p.latitude,
          lng: p.longitude,
          distance,
          source: "Google Maps (Serper)",
          mapsUrl: p.cid
            ? `https://www.google.com/maps?cid=${p.cid}`
            : `https://www.google.com/maps/dir/?api=1&destination=${p.latitude},${p.longitude}`
        };
      })
      .filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        const ratingOk = effectiveMinRating === 0 || p.rating >= effectiveMinRating;
        return p.distance <= radius && ratingOk;
      })
      .sort((a, b) => {
        if (b.rating !== a.rating) return b.rating - a.rating;
        if (b.reviews !== a.reviews) return b.reviews - a.reviews;
        return a.distance - b.distance;
      });

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      places,
      radius,
      category,
      provider: "serper-google-maps",
      updatedAt: Date.now()
    });
  } catch (_) {
    return res.status(500).json({ error: "Lỗi máy chủ khi quét địa điểm quanh bạn." });
  }
};
