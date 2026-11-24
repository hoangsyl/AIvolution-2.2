/**
 * AIvolution 2.0 — AI Travel Planner & Route Optimizer API
 * Generates realistic, structured day-by-day travel itineraries with budget breakdown,
 * over-budget warnings, Google Maps links, and clear separation between AI estimates and verified sources.
 */

const {
  LIMITS,
  applySecurityHeaders,
  enforceRateLimit,
  sanitizeText,
  parseJsonBody
} = require("./_lib/security");
const { generateTextCompletion, extractJsonObject, querySerper } = require("./_lib/ai-client");

function buildMapsUrl(placeName, city) {
  const q = placeName.toLowerCase().includes(city.toLowerCase()) ? placeName : `${placeName}, ${city}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function buildPlannerPrompt({ city, days, budgetVnd, people, interests, travelType, transport, verifiedSnippets }) {
  const snippetBlock = verifiedSnippets
    ? `\n[Địa điểm thực tế từ Google Search tại ${city}]:\n${verifiedSnippets}\nHãy ưu tiên sử dụng các địa điểm thực tế có trong danh sách hoặc các địa điểm nổi tiếng có thật tại ${city}.`
    : "";

  return `Bạn là chuyên gia lập lịch trình du lịch thực tế của AIvolution 2.0.
Yêu cầu người dùng:
- Thành phố: ${city}
- Số ngày: ${days} ngày
- Tổng ngân sách: ${budgetVnd.toLocaleString("vi-VN")} VNĐ cho ${people} người
- Sở thích: ${interests || "Khám phá, ăn uống, chụp ảnh"}
- Loại hình du lịch: ${travelType || "Tự túc"}
- Phương tiện: ${transport || "Xe máy / Grab"}${snippetBlock}

Quy tắc bắt buộc:
1. Sắp xếp các địa điểm trong cùng một ngày theo cụm gần nhau (tối ưu tuyến đường, tránh đi vòng).
2. TUYỆT ĐỐI KHÔNG tự bịa địa điểm không có thật hoặc giờ mở cửa không có cơ sở. Nếu không chắc giờ mở cửa ghi "Kiểm tra trên Google Maps trước khi đi".
3. Chi phí mỗi mục phải ghi rõ là số nguyên VNĐ ước tính tham khảo ("estimatedCostVnd") cho tổng ${people} người.
4. Mỗi ngày gồm 3–4 khung giờ: Sáng, Trưa, Chiều, Tối.
5. CHỈ TRẢ JSON THUẦN:
{
  "title": "Lịch trình ${days} ngày tại ${city}",
  "summary": "Tóm tắt 2 câu về lịch trình và cách tối ưu tuyến đường",
  "routeNote": "Ghi chú ngắn cách di chuyển giữa các điểm theo cụm gần nhau",
  "days": [
    {
      "day": 1,
      "theme": "Chủ đề ngày 1",
      "slots": [
        {
          "period": "Buổi sáng",
          "timeRange": "07:30 - 09:00",
          "activity": "Ăn sáng đặc sản",
          "placeName": "Tên địa điểm có thật",
          "address": "Địa chỉ thực tế tại ${city} (hoặc khu vực cụ thể)",
          "estimatedCostVnd": 120000,
          "duration": "1.5 giờ",
          "distanceNote": "Cách trung tâm ~2km",
          "tip": "Mẹo thực tế ngắn gọn",
          "sourceNote": "Gợi ý AI (kiểm tra giờ mở cửa trên Google Maps)"
        }
      ]
    }
  ],
  "packingTips": ["Mẹo chuẩn bị 1", "Mẹo chuẩn bị 2"]
}`;
}

module.exports = async (req, res) => {
  applySecurityHeaders(req, res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Phương thức không được hỗ trợ." });
  }

  if (!(await enforceRateLimit(req, res, { scope: "planner", maxRequests: 10, windowSec: 60 }))) return;

  const body = parseJsonBody(req);
  if (!body) return res.status(400).json({ error: "Dữ liệu không hợp lệ." });

  const city = sanitizeText(body.city || "Đà Nẵng", 80);
  const days = Math.min(Math.max(Math.round(Number(body.days) || 2), 1), 7);
  const budgetVnd = Math.min(Math.max(Math.round(Number(body.budgetVnd) || 1500000), 100000), 500000000);
  const people = Math.min(Math.max(Math.round(Number(body.people) || 2), 1), 20);
  const interests = sanitizeText(body.interests, LIMITS.MAX_PLANNER_PROMPT_CHARS);
  const travelType = sanitizeText(body.travelType || "Tự túc", 60);
  const transport = sanitizeText(body.transport || "Xe máy / Grab", 60);

  if (!city) {
    return res.status(400).json({ error: "Vui lòng nhập thành phố muốn đi." });
  }

  try {
    // Optional real-world grounding via Serper when configured
    let verifiedSnippets = "";
    const serperData = await querySerper(`${city} địa điểm du lịch quán ăn ngon nổi tiếng`, {
      num: 5,
      timeoutMs: 1800
    });
    if (serperData?.organic?.length) {
      verifiedSnippets = serperData.organic
        .slice(0, 5)
        .map((i) => `- ${i.title}: ${(i.snippet || "").slice(0, 120)}`)
        .join("\n");
    }

    const prompt = buildPlannerPrompt({
      city,
      days,
      budgetVnd,
      people,
      interests,
      travelType,
      transport,
      verifiedSnippets
    });

    const { text, provider } = await generateTextCompletion({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      maxTokens: 1800,
      timeoutMs: 9500
    });

    const rawPlan = extractJsonObject(text);
    const normalizedDays = Array.isArray(rawPlan.days)
      ? rawPlan.days.slice(0, days).map((d, dIdx) => ({
          day: Number(d.day) || dIdx + 1,
          theme: sanitizeText(d.theme || `Ngày ${dIdx + 1} tại ${city}`, 120),
          slots: Array.isArray(d.slots)
            ? d.slots.slice(0, 6).map((s) => {
                const placeName = sanitizeText(s.placeName || "Địa điểm gợi ý", 120);
                const cost = Math.max(0, Math.round(Number(s.estimatedCostVnd) || 0));
                return {
                  period: sanitizeText(s.period || "Trong ngày", 40),
                  timeRange: sanitizeText(s.timeRange || "Linh hoạt", 40),
                  activity: sanitizeText(s.activity || "Tham quan", 120),
                  placeName,
                  address: sanitizeText(s.address || city, 160),
                  estimatedCostVnd: cost,
                  duration: sanitizeText(s.duration || "1-2 giờ", 40),
                  distanceNote: sanitizeText(s.distanceNote || "", 80),
                  tip: sanitizeText(s.tip || "", 180),
                  sourceNote: sanitizeText(
                    s.sourceNote || (verifiedSnippets ? "Gợi ý AI kết hợp tham khảo Google Search" : "Gợi ý AI tham khảo"),
                    120
                  ),
                  mapsUrl: buildMapsUrl(placeName, city)
                };
              })
            : []
        }))
      : [];

    let totalEstimatedVnd = 0;
    normalizedDays.forEach((d) => {
      d.dayCostVnd = d.slots.reduce((sum, s) => sum + s.estimatedCostVnd, 0);
      totalEstimatedVnd += d.dayCostVnd;
    });

    const overBudget = totalEstimatedVnd > budgetVnd;
    const budgetDiffVnd = totalEstimatedVnd - budgetVnd;

    return res.status(200).json({
      id: `plan_${Date.now()}`,
      city,
      daysCount: days,
      budgetVnd,
      people,
      interests,
      travelType,
      transport,
      title: sanitizeText(rawPlan.title || `Lịch trình ${days} ngày tại ${city}`, 140),
      summary: sanitizeText(rawPlan.summary || "", 320),
      routeNote: sanitizeText(rawPlan.routeNote || "Các điểm được sắp xếp gần nhau để tối ưu thời gian di chuyển.", 240),
      days: normalizedDays,
      packingTips: Array.isArray(rawPlan.packingTips)
        ? rawPlan.packingTips.map((t) => sanitizeText(t, 140)).filter(Boolean).slice(0, 5)
        : [],
      totalEstimatedVnd,
      overBudget,
      budgetDiffVnd,
      budgetWarning: overBudget
        ? `Chi phí ước tính (${totalEstimatedVnd.toLocaleString("vi-VN")}đ) vượt ngân sách ${budgetDiffVnd.toLocaleString("vi-VN")}đ. Bạn có thể điều chỉnh bữa ăn hoặc chọn điểm miễn phí.`
        : `Chi phí ước tính (${totalEstimatedVnd.toLocaleString("vi-VN")}đ) nằm trong ngân sách ${budgetVnd.toLocaleString("vi-VN")}đ.`,
      dataLabel: verifiedSnippets ? "AI gợi ý + tham khảo Google Search" : "AI gợi ý (chi phí & giờ mở cửa mang tính tham khảo)",
      provider,
      createdAt: Date.now()
    });
  } catch (err) {
    if (err.code === "MISSING_AI_KEYS") {
      return res.status(503).json({
        error: "Chưa cấu hình GROQ_API_KEY hoặc OPENROUTER_API_KEY trên Vercel nên AI Travel Planner chưa thể tạo lịch trình.",
        code: "MISSING_API_KEY",
        missingEnv: ["GROQ_API_KEY", "OPENROUTER_API_KEY"]
      });
    }
    return res.status(502).json({
      error: "Không thể tạo lịch trình lúc này. Bạn thử lại sau vài giây nhé!"
    });
  }
};
