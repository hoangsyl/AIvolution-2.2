/**
 * AIvolution 2.0 — Smart Weather API (/api/weather)
 * Fetches real-time Open-Meteo data (current, apparent_temperature/feels-like, humidity,
 * wind, rain probability, 24h hourly, 7-day daily) + deterministic weather-based recommendations
 * (beach suitability, indoor/outdoor, packing tips).
 */

const { applySecurityHeaders, enforceRateLimit } = require("./_lib/security");
const { fetchWithTimeout } = require("./_lib/ai-client");

const CITIES = {
  danang: { id: "danang", name: "Đà Nẵng", lat: 16.0544, lng: 108.2022 },
  hoian: { id: "hoian", name: "Hội An", lat: 15.8801, lng: 108.3380 }
};

function buildSmartAdvice(current, todayRainProb, maxTemp) {
  const temp = Number(current?.temperature_2m ?? 28);
  const feels = Number(current?.apparent_temperature ?? temp);
  const wind = Number(current?.wind_speed_10m ?? 10);
  const code = Number(current?.weather_code ?? 0);
  const isStorm = code >= 95;
  const isRain = (code >= 51 && code <= 82) || todayRainProb >= 60;

  let beachAdvice = "Phù hợp đi biển Mỹ Khê / An Bàng (nên tránh nắng gắt 11h–14h).";
  if (isStorm) beachAdvice = "Không nên đi biển hôm nay do có dông sét/gió mạnh.";
  else if (isRain || wind >= 32) beachAdvice = "Hạn chế tắm biển do khả năng mưa cao hoặc gió lớn.";
  else if (temp < 23) beachAdvice = "Trời hơi mát/se lạnh, phù hợp dạo biển hơn là tắm biển.";

  const mode = isStorm || isRain ? "Trong nhà" : "Ngoài trời";
  const whereToGo = isStorm || isRain
    ? "Ưu tiên bảo tàng (Bảo tàng Điêu khắc Chăm), quán cà phê view phố cổ, TTTM hoặc thưởng thức ẩm thực nóng."
    : feels >= 34
    ? "Buổi sáng/chiều muộn thích hợp đi Sơn Trà, bãi biển hoặc Phố cổ Hội An; buổi trưa nên nghỉ tại quán cà phê máy lạnh."
    : "Thời tiết đẹp, rất lý tưởng đi dạo Phố cổ Hội An, Cầu Rồng, Ngũ Hành Sơn hoặc Bán đảo Sơn Trà.";

  const packing = [];
  if (isRain || todayRainProb >= 40) packing.push("Áo mưa gọn hoặc ô/dù");
  if (maxTemp >= 30 || (!isRain && code <= 2)) packing.push("Kem chống nắng, mũ và kính râm");
  if (wind >= 25 || temp <= 22) packing.push("Áo khoác nhẹ chắn gió");
  packing.push("Nước uống cá nhân");

  return {
    recommendedMode: mode,
    beachAdvice,
    whereToGo,
    packing
  };
}

module.exports = async (req, res) => {
  applySecurityHeaders(req, res);
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Phương thức không được hỗ trợ." });

  if (!(await enforceRateLimit(req, res, { scope: "weather", maxRequests: 40, windowSec: 60 }))) return;

  const cityKey = CITIES[req.query?.city] ? req.query.city : "danang";
  const city = CITIES[cityKey];
  const lat = Number.isFinite(Number(req.query?.lat)) ? Number(req.query.lat) : city.lat;
  const lng = Number.isFinite(Number(req.query?.lng)) ? Number(req.query.lng) : city.lng;

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,is_day` +
      `&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,precipitation_sum,wind_speed_10m_max` +
      `&timezone=Asia%2FBangkok&forecast_days=7`;

    const response = await fetchWithTimeout(url, {}, 4500);
    if (!response.ok) return res.status(502).json({ error: "Không tải được dữ liệu thời tiết Open-Meteo." });
    const data = await response.json();

    const todayRainProb = Number(data.daily?.precipitation_probability_max?.[0] || 0);
    const maxTemp = Number(data.daily?.temperature_2m_max?.[0] || data.current?.temperature_2m || 30);

    return res.status(200).json({
      city: { ...city, lat, lng },
      source: "Open-Meteo (open-meteo.com)",
      updatedAt: new Date().toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Ho_Chi_Minh"
      }),
      updatedAtMs: Date.now(),
      advice: buildSmartAdvice(data.current, todayRainProb, maxTemp),
      data
    });
  } catch (_) {
    return res.status(502).json({ error: "Lỗi kết nối dịch vụ thời tiết. Bạn thử làm mới sau giây lát nhé!" });
  }
};
