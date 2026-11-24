/**
 * AIvolution 2.0 — Multi-Mode AI Vision Scanner, AI Assistant & Hoài My Neural TTS
 * Preserves Groq Vision Primary (qwen3.8-27b) + OpenRouter Free Backup + Serper Auto-Verify
 * + Node.js TLS Hoài My Neural TTS, upgraded with strict security, 10 scan modes & photo compare.
 */

const tls = require("tls");
const crypto = require("crypto");
const {
  LIMITS,
  applySecurityHeaders,
  enforceRateLimit,
  validateImageBase64,
  validateChatMessages,
  sanitizeText,
  parseJsonBody
} = require("./_lib/security");
const { getServiceStatus } = require("./_lib/ai-client");

const CONFIG = {
  DN_HA_BOUNDS: { minLat: 15.70, maxLat: 16.20, minLng: 107.90, maxLng: 108.45 },
  GROQ_VISION_MODELS: ["qwen/qwen3.8-27b"],
  OPENROUTER_VISION_MODELS: [
    "google/gemma-3-27b-it:free",
    "mistralai/mistral-small-3.1-24b-instruct:free",
    "openrouter/free",
    "qwen/qwen2.5-vl-32b-instruct:free",
    "qwen/qwen2.5-vl-72b-instruct:free"
  ],
  OPENROUTER_CHAT_MODELS: [
    "openrouter/free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3.5-lightning:free"
  ],
  TOTAL_SCAN_BUDGET_MS: 12000,
  GROQ_VISION_TIMEOUT_MS: 6500,
  OPENROUTER_BACKUP_TIMEOUT_MS: 5000,
  HEDGE_DELAY_MS: 2200,
  GROQ_MODELS_TIMEOUT_MS: 1200,
  SERPER_TIMEOUT_MS: 850,
  CHAT_TIMEOUT_MS: 6500,
  TTS_TIMEOUT_MS: 4200,
  MODELS_CACHE_TTL_MS: 20 * 60 * 1000,
  SCAN_CACHE_TTL_MS: 15 * 60 * 1000,
  SERPER_CACHE_TTL_MS: 60 * 60 * 1000,
  TTS_CACHE_TTL_MS: 30 * 60 * 1000,
  KEY_COOLDOWN_429_MS: 45 * 1000,
  KEY_COOLDOWN_AUTH_MS: 10 * 60 * 1000,
  MODEL_COOLDOWN_MS: 60 * 1000,
  FRIENDLY_ERROR:
    "Opps! Mình chưa nhận diện được rõ ảnh này, có thể do thiếu sáng, mờ hoặc góc chụp chưa rõ. Bạn giữ chắc tay và chụp lại gần hơn nhé!"
};

const SCAN_MODE_HINTS = {
  auto: "Tự động phân loại chính xác đối tượng chính trong ảnh (món ăn, địa điểm, kiến trúc, sản phẩm, đồ vật, động vật, thực vật, biển báo hoặc văn bản).",
  food: "Chế độ MÓN ĂN & ĐỒ UỐNG: Nhận diện tên món ăn/đồ uống, đặc sản địa phương, thành phần nhìn thấy rõ, ước lượng calo từ nhãn hoặc nguyên liệu thấy rõ (bị che ghi 'Chưa đủ dữ liệu trên ảnh'), không bịa số.",
  place: "Chế độ ĐỊA ĐIỂM DU LỊCH: Nhận diện danh thắng, quán ăn, khu du lịch, trường học, tổ chức, logo thương hiệu tại Đà Nẵng – Hội An hoặc Việt Nam. Đặt la_dia_diem: true nếu là địa điểm.",
  architecture: "Chế độ CÔNG TRÌNH KIẾN TRÚC: Phân tích phong cách kiến trúc, vật liệu, kết cấu, niên đại nếu có cơ sở (không chắc ghi 'Chưa xác định rõ'), ý nghĩa văn hóa và lịch sử.",
  product: "Chế độ SẢN PHẨM: Đọc chính xác tên thương hiệu, dung tích/trọng lượng, thành phần, công dụng, nơi mua gợi ý và từ khóa mua hàng chính hãng.",
  object: "Chế độ ĐỒ VẬT: Nhận diện đồ vật đời sống, chất liệu, công dụng, đặc điểm nổi bật và lưu ý sử dụng.",
  animal: "Chế độ ĐỘNG VẬT: Nhận diện loài động vật, đặc điểm hình thái, tập tính, môi trường sống và lưu ý an toàn (nếu có). Không tự bịa tên khoa học nếu không chắc.",
  plant: "Chế độ THỰC VẬT: Nhận diện loài cây/hoa/lá, đặc điểm hình thái, công dụng, cách chăm sóc và lưu ý độc tính (nếu có).",
  sign: "Chế độ BIỂN BÁO: Đọc chính xác nội dung/ký hiệu biển báo giao thông, biển chỉ dẫn hoặc bảng nội quy và giải thích ý nghĩa thực tế.",
  ocr: "Chế độ ĐỌC CHỮ (OCR) & DỊCH: Trích xuất nguyên văn toàn bộ văn bản/chữ Hán-Nôm/tiếng Anh/tiếng Việt thấy rõ trong ảnh vào 'chu_doc_duoc_tren_anh', dịch nghĩa sang tiếng Việt dễ hiểu vào 'cau_chuyen_lich_su'."
};

const runtimeState = {
  cachedGroqModels: null,
  cachedGroqModelsAt: 0,
  badGroqVisionModels: new Set(),
  badOpenRouterModels: new Set(),
  modelCooldownUntil: new Map(),
  keyCooldownUntil: new Map(),
  rrIndex: Object.create(null),
  inFlight: new Map(),
  scanCache: new Map(),
  serperCache: new Map(),
  ttsCache: new Map()
};

function getCache(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    map.delete(key);
    return null;
  }
  return entry.val;
}

function setCache(map, key, val, ttlMs, maxEntries = 100) {
  if (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, { val, exp: Date.now() + ttlMs });
}

function runSingleFlight(key, fn) {
  if (runtimeState.inFlight.has(key)) return runtimeState.inFlight.get(key);
  const p = Promise.resolve().then(fn).finally(() => runtimeState.inFlight.delete(key));
  runtimeState.inFlight.set(key, p);
  return p;
}

function hashShort(str) {
  return crypto.createHash("sha256").update(String(str || "")).digest("hex").slice(0, 24);
}

function normalizeTextForMatch(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const ready = unique.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) <= now);
  const cooling = unique.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) > now);

  if (ready.length > 1) {
    const idx = (runtimeState.rrIndex[prefix] || 0) % ready.length;
    runtimeState.rrIndex[prefix] = idx + 1;
    return [...ready.slice(idx), ...ready.slice(0, idx), ...cooling];
  }
  return [...ready, ...cooling];
}

function markKeyCooldown(apiKey, ms = CONFIG.KEY_COOLDOWN_429_MS) {
  runtimeState.keyCooldownUntil.set(apiKey, Date.now() + ms);
}

function fetchWithTimeout(url, options = {}, timeoutMs = 4200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(600, timeoutMs));
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function clampToDaNangHoiAn(lat, lng, locationContext = "") {
  const numLat = Number(lat);
  const numLng = Number(lng);
  const ctx = String(locationContext || "").toLowerCase();
  const { minLat, maxLat, minLng, maxLng } = CONFIG.DN_HA_BOUNDS;

  if (
    Number.isFinite(numLat) &&
    Number.isFinite(numLng) &&
    numLat >= minLat &&
    numLat <= maxLat &&
    numLng >= minLng &&
    numLng <= maxLng
  ) {
    return { lat: Number(numLat.toFixed(6)), lng: Number(numLng.toFixed(6)) };
  }
  if (ctx.includes("hội an") || ctx.includes("hoi an")) {
    return { lat: 15.8801, lng: 108.3380 };
  }
  return { lat: 16.0544, lng: 108.2022 };
}

function detectLocalCityName(areaPoint, locationContext = "") {
  const ctx = normalizeTextForMatch(locationContext);
  if (ctx.includes("hoi an")) return "Hội An";
  if (areaPoint && Number(areaPoint.lat) < 15.96) return "Hội An";
  return "Đà Nẵng";
}

function buildDnHaMapsUrl({ query = "", lat, lng, locationContext = "" } = {}) {
  const point = clampToDaNangHoiAn(lat, lng, locationContext);
  const cleanQuery = String(query || "").trim();
  const scopedQuery = cleanQuery
    ? (/đà nẵng|hội an|quảng nam|việt nam/i.test(cleanQuery) ? cleanQuery : `${cleanQuery}, Hội An - Đà Nẵng`)
    : "Hội An - Đà Nẵng";

  const params = new URLSearchParams({
    api: "1",
    query: scopedQuery,
    center: `${point.lat},${point.lng}`,
    zoom: "15"
  });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

function buildDnHaDirectionsUrl({ destName = "", lat, lng, locationContext = "" } = {}) {
  const origin = clampToDaNangHoiAn(lat, lng, locationContext);
  const cleanDest = String(destName || "").trim();
  const scopedDest = cleanDest
    ? (/đà nẵng|hội an|quảng nam|việt nam/i.test(cleanDest) ? cleanDest : `${cleanDest}, Hội An - Đà Nẵng`)
    : "Hội An, Đà Nẵng";

  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: scopedDest,
    travelmode: "driving"
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function attachMapLinks(payload, { areaPoint, locationContext }) {
  if (payload.la_dia_diem) {
    const hasExactAddr = payload.dia_chi && !/không áp dụng|chưa xác định/i.test(payload.dia_chi);
    const placeQuery = hasExactAddr ? `${payload.ten_dia_diem}, ${payload.dia_chi}` : payload.ten_dia_diem;
    payload.hien_chi_duong = true;
    payload.google_maps_url = buildDnHaMapsUrl({
      query: placeQuery,
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      locationContext
    });
    payload.chi_duong_url = buildDnHaDirectionsUrl({
      destName: placeQuery,
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      locationContext
    });
  } else {
    const buyQuery = payload.thong_tin_san_pham?.tu_khoa_mua_hang || `mua ${payload.ten_dia_diem}`;
    payload.hien_chi_duong = false;
    payload.google_maps_url = buildDnHaMapsUrl({
      query: buyQuery,
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      locationContext
    });
    payload.chi_duong_url = "";
  }
  return payload;
}

function extractJson(rawText) {
  const cleaned = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/gi, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Phản hồi AI không phải JSON hợp lệ");
  }

  let jsonStr = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1").replace(/[\u0000-\u0019]+/g, " ");
    return JSON.parse(jsonStr);
  }
}

function isInvalidTitle(str) {
  const s = String(str || "").trim();
  if (!s || s.length < 2) return true;
  return (
    /^(không áp dụng|chưa xác định|không xác định|chưa rõ|không rõ|không có|n\/a|none|null|vật thể|đối tượng|sản phẩm)$/i.test(s) ||
    /chưa xác định|không xác định|chưa rõ từ ảnh|không áp dụng/i.test(s)
  );
}

function deriveCleanTitle({ sp, data, ocrText, loai }) {
  const candidates = [sp.chi_tiet_san_pham, data.cau_chuyen_lich_su, data.giai_thoai_dac_biet];
  for (const raw of candidates) {
    const text = String(raw || "")
      .replace(/^(ảnh chụp|hình ảnh|đây là|đối tượng là|vật thể là|sản phẩm là)\s+/i, "")
      .trim();
    if (!text || isInvalidTitle(text)) continue;

    let shortName = text
      .split(/[.,;(]|\s+(?:mang ý nghĩa|thường được|được sử dụng|dùng để|treo trên|đặt trên|có thiết kế)/i)[0]
      .trim();

    if (shortName.length > 56) {
      shortName = shortName.slice(0, 56).replace(/\s+\S*$/, "").trim();
    }
    if (shortName.length >= 4) {
      return shortName.charAt(0).toUpperCase() + shortName.slice(1);
    }
  }
  if (ocrText && !/không có chữ/i.test(ocrText)) return ocrText.slice(0, 56);
  return loai && !isInvalidTitle(loai) ? loai : "Đối tượng nhận diện";
}

function normalizeScanResult(raw, { areaPoint, locationContext, provider, scanMode }) {
  const data = raw && typeof raw === "object" ? raw : {};
  if (data.khong_nhan_dien_duoc === true || data.error) {
    return { error: CONFIG.FRIENDLY_ERROR };
  }

  const ocrText = String(data.chu_doc_duoc_tren_anh || "").trim();
  const sp = data.thong_tin_san_pham && typeof data.thong_tin_san_pham === "object" ? data.thong_tin_san_pham : {};
  const hv = data.han_viet && typeof data.han_viet === "object" ? data.han_viet : {};
  const dg = data.danh_gia_ban_dia && typeof data.danh_gia_ban_dia === "object" ? data.danh_gia_ban_dia : {};

  const loai = String(data.loai_doi_tuong || "Vật thể").trim();
  let ten = String(data.ten_dia_diem || "").trim();
  if (isInvalidTitle(ten)) {
    ten = deriveCleanTitle({ sp, data, ocrText, loai });
  }

  const isPlace =
    data.la_dia_diem === true ||
    /di tích|kiến trúc|nhà hàng|quán ăn|workshop|shop|hán nôm|địa điểm|trường học|tổ chức|thương hiệu/i.test(loai);

  const diaChi = String(data.dia_chi || (isPlace ? "Chưa xác định rõ từ ảnh" : "Không áp dụng")).trim();
  const rawPrice = String(data.nien_dai_hoac_gia || "").trim();
  const nienDaiGia =
    !rawPrice || /chưa xác định|không áp dụng/i.test(rawPrice)
      ? (isPlace ? "Chưa xác minh được" : "Chưa có nguồn giá xác minh")
      : rawPrice;

  const isFoodOrDrink = /thức ăn|đồ uống|món ăn|nước uống|thực phẩm|bánh|trái cây/i.test(loai);
  const rawCalo = String(sp.calo_uoc_tinh || "").trim();
  const safeCalo = !isFoodOrDrink
    ? "Không áp dụng"
    : /chưa đủ dữ liệu|chưa xác định/i.test(rawCalo)
    ? "Chưa đủ dữ liệu trên ảnh"
    : /\d+/.test(rawCalo)
    ? rawCalo
    : "Chưa đủ dữ liệu trên ảnh";

  const rawConf = String(data.muc_do_chac_chan || "").trim();
  const safeConf = /^(Cao|Trung bình|Thấp)$/i.test(rawConf) ? rawConf : "Ước tính từ ảnh (chưa xác minh)";

  const dacDiem = Array.isArray(data.dac_diem_nhan_dang)
    ? data.dac_diem_nhan_dang.map((x) => sanitizeText(x, 140)).filter(Boolean).slice(0, 5)
    : [];

  const goiY = Array.isArray(data.goi_y_lien_quan)
    ? data.goi_y_lien_quan.map((x) => sanitizeText(x, 120)).filter(Boolean).slice(0, 4)
    : [];

  const normalized = {
    loai_doi_tuong: loai,
    scan_mode: scanMode || "auto",
    la_dia_diem: isPlace,
    ten_dia_diem: ten,
    dia_chi: diaChi,
    nien_dai_hoac_gia: nienDaiGia,
    muc_do_chac_chan: safeConf,
    nguon_xac_minh: "Phân tích hình ảnh AI (chưa có nguồn đối chiếu trực tiếp)",
    nguon_url: "",
    dac_diem_nhan_dang: dacDiem,
    goi_y_lien_quan: goiY,
    cau_chuyen_lich_su: String(data.cau_chuyen_lich_su || "").trim(),
    giai_thoai_dac_biet: String(data.giai_thoai_dac_biet || "").trim(),
    thong_tin_san_pham: {
      hien_thi: typeof sp.hien_thi === "boolean" ? sp.hien_thi : true,
      calo_uoc_tinh: safeCalo,
      tot_cho_suc_khoe: isFoodOrDrink
        ? String(sp.tot_cho_suc_khoe || "Chưa đủ dữ liệu đánh giá").trim()
        : String(sp.tot_cho_suc_khoe || "Không áp dụng").trim(),
      chi_tiet_san_pham: String(sp.chi_tiet_san_pham || "Nhận diện từ đặc điểm trên ảnh").trim(),
      noi_mua_goi_y: String(sp.noi_mua_goi_y || "Đà Nẵng – Hội An").trim(),
      tu_khoa_mua_hang: String(sp.tu_khoa_mua_hang || "").trim()
    },
    han_viet: {
      co_han_viet: Boolean(hv.co_han_viet && String(hv.chu_goc || "").trim()),
      chu_goc: String(hv.chu_goc || "").trim(),
      phien_am: String(hv.phien_am || "").trim(),
      phan_tich_tung_tu: Array.isArray(hv.phan_tich_tung_tu) ? hv.phan_tich_tung_tu : [],
      y_nghia_tong_the: String(hv.y_nghia_tong_the || "").trim()
    },
    danh_gia_ban_dia: {
      tom_tat: String(dg.tom_tat || "Nhận xét thực tế theo chi tiết quan sát trong ảnh.").trim(),
      review_mau: Array.isArray(dg.review_mau)
        ? dg.review_mau.map((r) => String(r || "").trim()).filter(Boolean).slice(0, 2)
        : []
    },
    toa_do_khu_vuc: {
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      khu_vuc: "Đà Nẵng – Hội An"
    },
    _ocr: ocrText,
    _verified: false,
    _provider: provider
  };

  return attachMapLinks(normalized, { areaPoint, locationContext });
}

function buildVisionPrompt(locationContext, scanMode = "auto") {
  const modeHint = SCAN_MODE_HINTS[scanMode] || SCAN_MODE_HINTS.auto;
  return `Chuyên gia Vision & OCR AIvolution 2.0 (${locationContext || "Hội An – Đà Nẵng"}).
Chế độ hiện tại: ${modeHint}
Luật nghiêm ngặt:
1. OCR: Chép nguyên văn chữ/logo/dung tích/biển báo/Hán-Nôm thấy rõ vào "chu_doc_duoc_tren_anh" (không có ghi "Không có chữ").
2. "ten_dia_diem": Tên tiếng Việt cụ thể, chính xác của đối tượng/món ăn/địa điểm/động vật/thực vật/biển báo (cấm ghi "Chưa xác định").
3. CHỐNG BỊA ĐẶT: Tuyệt đối KHÔNG bịa giá, địa chỉ, năm thành lập hoặc độ chính xác phần trăm. Nếu không xác định được từ ảnh: "dia_chi" ghi "Chưa xác định rõ từ ảnh", "nien_dai_hoac_gia" ghi "Chưa xác minh được".
4. "muc_do_chac_chan": Chỉ chọn 1 trong 3 mức: "Cao", "Trung bình", "Thấp" dựa trên độ rõ nét và đặc trưng ảnh.
5. "dac_diem_nhan_dang": 2–4 gạch đầu dòng ngắn nêu dấu hiệu trực quan nhìn thấy trong ảnh.
6. "goi_y_lien_quan": 2–3 gợi ý hữu ích liên quan (món ăn kèm, địa điểm gần đó, cách dùng hoặc câu hỏi tiếp theo).
7. CHỈ TRẢ JSON THUẦN:
{"khong_nhan_dien_duoc":false,"chu_doc_duoc_tren_anh":"","loai_doi_tuong":"Món ăn & Đồ uống|Địa điểm du lịch|Công trình kiến trúc|Sản phẩm|Đồ vật|Động vật|Thực vật|Biển báo|Văn bản (OCR)|Trường học & Tổ chức|Thương hiệu|Di tích|Nhà hàng & Quán ăn|Vật thể","la_dia_diem":false,"ten_dia_diem":"","dia_chi":"","nien_dai_hoac_gia":"","muc_do_chac_chan":"Cao|Trung bình|Thấp","dac_diem_nhan_dang":["Đặc điểm 1","Đặc điểm 2"],"goi_y_lien_quan":["Gợi ý 1","Gợi ý 2"],"cau_chuyen_lich_su":"2-3 câu chi tiết về bản chất, nguồn gốc/ý nghĩa hoặc bản dịch văn bản","giai_thoai_dac_biet":"2-3 câu mô tả sắc nét màu sắc, bố cục, chất liệu, topping hoặc chi tiết nổi bật nhìn thấy","thong_tin_san_pham":{"hien_thi":true,"calo_uoc_tinh":"","tot_cho_suc_khoe":"1-2 câu đánh giá dinh dưỡng/an toàn hoặc Không áp dụng","chi_tiet_san_pham":"2 câu về định lượng/chất liệu/thông số","noi_mua_goi_y":"Khu vực gợi ý tại Đà Nẵng – Hội An hoặc Không áp dụng","tu_khoa_mua_hang":""},"han_viet":{"co_han_viet":false,"chu_goc":"","phien_am":"","phan_tich_tung_tu":[],"y_nghia_tong_the":""},"danh_gia_ban_dia":{"tom_tat":"1-2 câu nhận xét khách quan","review_mau":["Điểm nổi bật","Lưu ý thực tế"]}}`;
}

function buildComparePrompt(locationContext) {
  return `Chuyên gia AI Photo Compare của AIvolution 2.0 (${locationContext || "Đà Nẵng – Hội An"}).
Hãy so sánh khách quan 2 hình ảnh (Ảnh 1 và Ảnh 2). Tuyệt đối không bịa giá hoặc thông số không thấy trên ảnh.
CHỈ TRẢ JSON THUẦN:
{"tieu_de":"Tên so sánh ngắn gọn","anh_1":{"ten":"Tên đối tượng ảnh 1","diem_noi_bat":"1-2 câu"},"anh_2":{"ten":"Tên đối tượng ảnh 2","diem_noi_bat":"1-2 câu"},"diem_giong":["Điểm giống 1","Điểm giống 2"],"diem_khac":["Điểm khác 1","Điểm khác 2"],"khuyen_nghi":"2 câu gợi ý nên chọn cái nào tùy nhu cầu thực tế"}`;
}

async function fetchWorkingGroqModels(apiKey, timeoutMs = CONFIG.GROQ_MODELS_TIMEOUT_MS) {
  const now = Date.now();
  if (runtimeState.cachedGroqModels && now - runtimeState.cachedGroqModelsAt < CONFIG.MODELS_CACHE_TTL_MS) {
    return runtimeState.cachedGroqModels;
  }
  return runSingleFlight("groq:models", async () => {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${apiKey}` } },
      timeoutMs
    );
    if (!res.ok) throw new Error(`Groq models HTTP ${res.status}`);
    const data = await res.json();
    const activeModels = (data.data || [])
      .map((m) => m.id)
      .filter((id) => id && !/whisper|tts|guard|safeguard|embed|prompt-guard|playai|orpheus|compound/i.test(id));
    if (!activeModels.length) throw new Error("Không tìm thấy model Groq");
    runtimeState.cachedGroqModels = activeModels;
    runtimeState.cachedGroqModelsAt = Date.now();
    return activeModels;
  });
}

async function callGroqVision({ apiKey, model, prompt, imageUrls, timeoutMs }) {
  const isQwen38 = /qwen3\.8/i.test(model);
  const contentParts = [{ type: "text", text: prompt }];
  for (const url of imageUrls) {
    contentParts.push({ type: "image_url", image_url: { url } });
  }
  const payload = {
    model,
    temperature: 0.1,
    max_completion_tokens: isQwen38 ? 950 : 1200,
    messages: [{ role: "user", content: contentParts }]
  };
  if (isQwen38) payload.reasoning_effort = "none";

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    },
    timeoutMs
  );

  const rawText = await res.text();
  if (!res.ok) {
    const err = new Error(`Groq(${model}) HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const parsed = JSON.parse(rawText.trim());
  const msgObj = parsed.choices?.[0]?.message || {};
  const content = msgObj.content || msgObj.reasoning || "";
  if (!content) throw new Error("Empty Groq vision content");
  return extractJson(content);
}

async function runGroqPrimaryVision({ apiKeys, prompt, imageUrls, deadline }) {
  const errors = [];
  const now = Date.now();
  const availableModels = CONFIG.GROQ_VISION_MODELS.filter((m) => !runtimeState.badGroqVisionModels.has(m));
  const orderedModels = [
    ...availableModels.filter((m) => (runtimeState.modelCooldownUntil.get(m) || 0) <= now),
    ...availableModels.filter((m) => (runtimeState.modelCooldownUntil.get(m) || 0) > now)
  ];

  for (const model of orderedModels) {
    if (deadline - Date.now() < 1800) break;
    for (const apiKey of apiKeys.slice(0, 3)) {
      const remaining = deadline - Date.now();
      if (remaining < 1800) break;
      try {
        const result = await callGroqVision({
          apiKey,
          model,
          prompt,
          imageUrls,
          timeoutMs: Math.min(CONFIG.GROQ_VISION_TIMEOUT_MS, remaining)
        });
        if (result && typeof result === "object") {
          return { result, provider: `groq:${String(model).split("/").pop()}` };
        }
      } catch (err) {
        const msg = err?.name === "AbortError" ? "Timeout" : err.message;
        errors.push(msg);
        if (err.status === 400 || err.status === 404) {
          runtimeState.badGroqVisionModels.add(model);
          break;
        }
        if (err.status === 429) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
          continue;
        }
        if (err.status === 401 || err.status === 403) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
          continue;
        }
        if (err.status === 502 || err.status === 503 || msg.includes("Timeout")) {
          if (availableModels.length > 1) {
            runtimeState.modelCooldownUntil.set(model, Date.now() + CONFIG.MODEL_COOLDOWN_MS);
          }
          break;
        }
      }
    }
  }

  const finalErr = new Error("GROQ_VISION_FAILED");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  finalErr.isOverloaded = errors.some((e) => e.includes("503") || e.includes("502") || e.includes("Timeout"));
  throw finalErr;
}

async function callSingleOpenRouterVision({ apiKey, model, prompt, imageUrls, timeoutMs }) {
  const contentParts = [{ type: "text", text: prompt }];
  for (const url of imageUrls) {
    contentParts.push({ type: "image_url", image_url: { url } });
  }

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
        temperature: 0.1,
        max_tokens: 1200,
        reasoning: { enabled: false },
        provider: { sort: "throughput" },
        messages: [{ role: "user", content: contentParts }]
      })
    },
    timeoutMs
  );

  const rawText = await res.text();
  if (!res.ok) {
    if (res.status === 404) runtimeState.badOpenRouterModels.add(model);
    else if (res.status === 429 || res.status === 502 || res.status === 503) {
      runtimeState.modelCooldownUntil.set(model, Date.now() + CONFIG.MODEL_COOLDOWN_MS);
      if (res.status === 429 && model === "openrouter/free") markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
    } else if (res.status === 401 || res.status === 402 || res.status === 403) {
      markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
    }
    throw new Error(`OpenRouter HTTP ${res.status}`);
  }

  const parsed = JSON.parse(rawText.trim());
  const msgObj = parsed.choices?.[0]?.message || {};
  const content = msgObj.content || msgObj.reasoning || "";
  if (!content) {
    runtimeState.modelCooldownUntil.set(model, Date.now() + CONFIG.MODEL_COOLDOWN_MS);
    throw new Error("Empty OpenRouter content");
  }
  const usedModel = parsed.model || model;
  return { result: extractJson(content), provider: `openrouter:${String(usedModel).split("/").pop()}` };
}

async function runOpenRouterBackupVision({ apiKeys, prompt, imageUrls, deadline }) {
  const now = Date.now();
  const available = CONFIG.OPENROUTER_VISION_MODELS.filter((m) => !runtimeState.badOpenRouterModels.has(m));
  const orderedModels = [
    ...available.filter((m) => (runtimeState.modelCooldownUntil.get(m) || 0) <= now),
    ...available.filter((m) => (runtimeState.modelCooldownUntil.get(m) || 0) > now)
  ];

  const primaryKey = apiKeys[0];
  const backupKey = apiKeys[1] || apiKeys[0];
  const errors = [];

  const m1 = orderedModels[0];
  const m2 = orderedModels[1];
  if (m1 && m2) {
    try {
      let hedgeTimer = null;
      let startedP2 = false;
      let triggerP2 = null;

      const p1 = callSingleOpenRouterVision({
        apiKey: primaryKey,
        model: m1,
        prompt,
        imageUrls,
        timeoutMs: Math.min(CONFIG.OPENROUTER_BACKUP_TIMEOUT_MS, deadline - Date.now())
      });

      const p2 = new Promise((resolve, reject) => {
        triggerP2 = () => {
          if (startedP2) return;
          startedP2 = true;
          clearTimeout(hedgeTimer);
          const left = deadline - Date.now();
          if (left < 1400) return reject(new Error("Timeout"));
          callSingleOpenRouterVision({
            apiKey: backupKey,
            model: m2,
            prompt,
            imageUrls,
            timeoutMs: Math.min(CONFIG.OPENROUTER_BACKUP_TIMEOUT_MS, left)
          }).then(resolve, reject);
        };
        hedgeTimer = setTimeout(triggerP2, CONFIG.HEDGE_DELAY_MS);
      });

      p1.then(
        () => clearTimeout(hedgeTimer),
        () => triggerP2 && triggerP2()
      );
      return await Promise.any([p1, p2]);
    } catch (aggErr) {
      const list = aggErr?.errors || [aggErr];
      list.forEach((e) => errors.push(e?.message || "Failed"));
    }
  }

  for (const model of orderedModels.slice(2, 4)) {
    const remaining = deadline - Date.now();
    if (remaining < 1400) break;
    try {
      return await callSingleOpenRouterVision({
        apiKey: backupKey,
        model,
        prompt,
        imageUrls,
        timeoutMs: Math.min(3800, remaining)
      });
    } catch (err) {
      errors.push(err?.message || "Failed");
    }
  }

  const finalErr = new Error("OPENROUTER_VISION_FAILED");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  finalErr.isOverloaded = errors.some((e) => e.includes("503") || e.includes("502") || e.includes("Timeout"));
  throw finalErr;
}

async function querySerperCached(query, num = 4, timeoutMs = CONFIG.SERPER_TIMEOUT_MS) {
  const normKey = `serper:${normalizeTextForMatch(query)}:${num}`;
  const cached = getCache(runtimeState.serperCache, normKey);
  if (cached !== null) return cached;

  const apiKeys = collectApiKeys("SERPER_API_KEY");
  if (!apiKeys.length || !query) return null;

  return runSingleFlight(normKey, async () => {
    for (const apiKey of apiKeys.slice(0, 2)) {
      try {
        const res = await fetchWithTimeout(
          "https://google.serper.dev/search",
          {
            method: "POST",
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, gl: "vn", hl: "vi", num })
          },
          timeoutMs
        );
        if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 429) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
          continue;
        }
        if (!res.ok) continue;
        const data = await res.json();
        setCache(runtimeState.serperCache, normKey, data, CONFIG.SERPER_CACHE_TTL_MS, 250);
        return data;
      } catch (_) {
        continue;
      }
    }
    return null;
  });
}

function extractPriceRangeFromSerper(data) {
  const texts = [];
  if (data.answerBox?.snippet) texts.push(data.answerBox.snippet);
  (data.organic || []).forEach((item) => {
    if (item.price) texts.push(String(item.price));
    if (item.title) texts.push(item.title);
    if (item.snippet) texts.push(item.snippet);
  });

  const fullText = texts.join(" | ");
  const prices = [];
  const regexVnd = /(?:₫\s*)?(\d{1,3}(?:[.,]\d{3})+)\s*(?:đ|₫|vnđ|vnd)?/gi;
  let match;
  while ((match = regexVnd.exec(fullText)) !== null) {
    const val = Number(match[1].replace(/[.,]/g, ""));
    if (val >= 5000 && val <= 100000000) prices.push(val);
  }
  const regexK = /\b(\d{2,4})k\b/gi;
  while ((match = regexK.exec(fullText)) !== null) {
    const val = Number(match[1]) * 1000;
    if (val >= 5000 && val <= 50000000) prices.push(val);
  }
  if (!prices.length) return null;

  prices.sort((a, b) => a - b);
  const cut = prices.length >= 6 ? Math.floor(prices.length * 0.25) : prices.length >= 4 ? 1 : 0;
  const trimmed = cut > 0 ? prices.slice(cut, prices.length - cut) : prices;
  const minP = trimmed[0];
  const maxP = trimmed[trimmed.length - 1];
  const fmt = (n) => n.toLocaleString("vi-VN");
  return minP === maxP ? `${fmt(minP)} VNĐ` : `${fmt(minP)} - ${fmt(maxP)} VNĐ`;
}

async function autoVerifyWithGoogle(payload, { areaPoint, locationContext, timeoutMs }) {
  if (!payload || !payload.ten_dia_diem || isInvalidTitle(payload.ten_dia_diem)) return payload;

  const isSchoolOrOrg = /trường học|tổ chức|di tích|hán nôm|kiến trúc/i.test(payload.loai_doi_tuong);
  const isPlaceOrBrand =
    payload.la_dia_diem ||
    /trường học|tổ chức|thương hiệu|nhà hàng|quán ăn|shop|workshop|di tích|kiến trúc|địa điểm/i.test(payload.loai_doi_tuong);
  const isFood = /thức ăn|đồ uống|món ăn|nước uống|thực phẩm/i.test(payload.loai_doi_tuong);

  if (isPlaceOrBrand) {
    const cityHint = detectLocalCityName(areaPoint, locationContext);
    const hasRegionInName = /hội an|đà nẵng|quảng nam|hà nội|tp\.?hcm|hồ chí minh|huế/i.test(
      `${payload.ten_dia_diem} ${payload._ocr || ""}`
    );
    const searchQuery = isSchoolOrOrg
      ? `${payload.ten_dia_diem}${hasRegionInName ? "" : ` ${cityHint}`} địa chỉ năm thành lập`
      : `${payload.ten_dia_diem}${hasRegionInName ? "" : ` ${cityHint}`} địa chỉ giá`;

    const data = await querySerperCached(searchQuery, 4, timeoutMs);
    if (!data) return payload;

    let verifiedAny = false;
    const kg = data.knowledgeGraph || {};
    const attrs = kg.attributes && typeof kg.attributes === "object" ? kg.attributes : {};
    const topOrganic = (data.organic || [])[0];
    const allSnippets = [
      data.answerBox?.snippet || "",
      kg.description || "",
      ...(data.organic || []).map((i) => `${i.title || ""} - ${i.snippet || ""}`)
    ].join(" | ");

    const attrAddr = attrs["Địa chỉ"] || attrs["Address"] || kg.address || "";
    if (attrAddr && attrAddr.length >= 6) {
      payload.dia_chi = String(attrAddr).trim();
      verifiedAny = true;
    } else if (/chưa xác định|không áp dụng/i.test(payload.dia_chi)) {
      const addrMatch = allSnippets.match(/Địa chỉ[:\s]+([^.|;\n]{8,95})/i);
      if (addrMatch) {
        payload.dia_chi = addrMatch[1].trim();
        verifiedAny = true;
      }
    }

    const foundedAttr = attrs["Thành lập"] || attrs["Năm thành lập"] || attrs["Founded"] || "";
    if (isSchoolOrOrg) {
      if (foundedAttr) {
        payload.nien_dai_hoac_gia = `Thành lập ${String(foundedAttr).trim()}`;
        verifiedAny = true;
      } else if (/chưa xác minh|chưa xác định|tham khảo/i.test(payload.nien_dai_hoac_gia)) {
        const yearMatch = allSnippets.match(
          /thành lập(?:\s+vào)?(?:\s+ngày)?\s+(\d{1,2}[\/.-]\d{1,2}[\/.-](?:1\d{3}|20\d{2})|(?:năm\s+)?(?:1\d{3}|20\d{2}))/i
        );
        if (yearMatch) {
          const cleanYear = yearMatch[1].replace(/^năm\s+/i, "").trim();
          payload.nien_dai_hoac_gia = /^\d{4}$/.test(cleanYear) ? `Thành lập năm ${cleanYear}` : `Thành lập ${cleanYear}`;
          verifiedAny = true;
        }
      }
    } else {
      const realPrice = extractPriceRangeFromSerper(data);
      if (realPrice) {
        payload.nien_dai_hoac_gia = realPrice;
        verifiedAny = true;
      }
    }

    const hoursAttr = attrs["Giờ"] || attrs["Giờ mở cửa"] || attrs["Hours"] || "";
    if (hoursAttr && payload.thong_tin_san_pham) {
      const baseLoc = !/chưa xác định|không áp dụng/i.test(payload.dia_chi)
        ? payload.dia_chi
        : payload.thong_tin_san_pham.noi_mua_goi_y;
      payload.thong_tin_san_pham.noi_mua_goi_y = `${baseLoc} (${String(hoursAttr).trim()})`;
      verifiedAny = true;
    } else if (!/chưa xác định|không áp dụng/i.test(payload.dia_chi) && payload.thong_tin_san_pham) {
      payload.thong_tin_san_pham.noi_mua_goi_y = payload.dia_chi;
    }

    if (kg.rating) {
      const countText = kg.ratingCount ? ` (${Number(kg.ratingCount).toLocaleString("vi-VN")} đánh giá)` : "";
      payload.danh_gia_ban_dia.tom_tat = `Google: ${kg.rating}/5 ⭐${countText}. ${payload.danh_gia_ban_dia.tom_tat}`;
      verifiedAny = true;
    }

    payload._verified = verifiedAny;
    if (verifiedAny) {
      payload.nguon_xac_minh = topOrganic?.title
        ? `Google Search (${topOrganic.title.slice(0, 60)})`
        : "Google Knowledge Graph / Search";
      payload.nguon_url = topOrganic?.link || kg.website || "";
    }
    return attachMapLinks(payload, { areaPoint, locationContext });
  }

  const hasBrandText = Boolean(payload._ocr && !/^không có chữ$/i.test(payload._ocr) && payload._ocr.length >= 3);
  if (!hasBrandText || isFood) return payload;

  const unitMatch = String(payload._ocr || "").match(/\b\d+\s*(?:ml|g|kg|lít|l|viên|gói)\b/i);
  const searchName =
    unitMatch && !payload.ten_dia_diem.toLowerCase().includes(unitMatch[0].toLowerCase())
      ? `${payload.ten_dia_diem} ${unitMatch[0]}`
      : payload.ten_dia_diem;

  const data = await querySerperCached(`giá ${searchName} chính hãng`, 4, timeoutMs);
  if (data) {
    const realPrice = extractPriceRangeFromSerper(data);
    if (realPrice) {
      payload.nien_dai_hoac_gia = realPrice;
      payload._verified = true;
      const topOrganic = (data.organic || [])[0];
      payload.nguon_xac_minh = topOrganic?.title ? `Google Search (${topOrganic.title.slice(0, 60)})` : "Google Search";
      payload.nguon_url = topOrganic?.link || "";
    }
  }
  return payload;
}

// ==========================================
// AI ASSISTANT (MARKDOWN + BILINGUAL + CONTEXT + OPTIONAL IMAGE)
// ==========================================
async function searchWebContextForChat(userText, lastScan) {
  if (!userText) return { text: "", places: [] };
  const needSearch =
    /quán|ăn gì|ở đâu|giá|mấy giờ|đường|thời tiết|review|ngon|mua|địa chỉ|sự kiện|vé|trường|chỗ nào|hotel|restaurant|cafe|where|price/i.test(
      userText
    );
  if (!needSearch) return { text: "", places: [] };

  let query = userText.trim();
  if (/món này|cái này|sản phẩm này|vừa quét|trường này|quán này/i.test(query) && lastScan?.ten_dia_diem) {
    query = `${lastScan.ten_dia_diem} Hội An Đà Nẵng`;
  } else if (!/đà nẵng|hội an|da nang|hoi an/i.test(query)) {
    query = `${query} Đà Nẵng Hội An`;
  }

  const data = await querySerperCached(query, 4, CONFIG.SERPER_TIMEOUT_MS);
  if (!data) return { text: "", places: [] };
  const organic = (data.organic || []).slice(0, 3);
  const snippets = organic.map((item) => `- ${item.title}: ${item.snippet}`).join("\n");
  const places = organic
    .filter((i) => i.title && i.link)
    .map((i) => ({ title: i.title.slice(0, 80), snippet: (i.snippet || "").slice(0, 120), url: i.link }));
  return {
    text: snippets ? `\n[Dữ liệu Google tham khảo]:\n${snippets}` : "",
    places
  };
}

function buildSmartChatSystemPrompt({ locationContext, lastScan, webContext, weatherSummary }) {
  const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const scanContext =
    lastScan && lastScan.ten_dia_diem
      ? `\n[Kết quả quét gần nhất trong phiên]: ${lastScan.ten_dia_diem} (${lastScan.loai_doi_tuong || ""}) | Địa chỉ: ${lastScan.dia_chi || "Chưa rõ"} | Giá/Niên đại: ${lastScan.nien_dai_hoac_gia || "Chưa rõ"} | Calo: ${lastScan.thong_tin_san_pham?.calo_uoc_tinh || "Không áp dụng"}`
      : "";
  const wxContext = weatherSummary ? `\n[Thời tiết hiện tại]: ${weatherSummary}` : "";

  return `Bạn là Trợ lý AI cá nhân của AIvolution 2.0 (chuyên gia khám phá, du lịch, ẩm thực, dịch thuật và đời sống tại Đà Nẵng – Hội An).
Thời gian Việt Nam: ${vnTime}. Vị trí: ${locationContext || "Đà Nẵng – Hội An"}.${scanContext}${wxContext}${webContext}

Nguyên tắc:
- Ưu tiên trả lời tiếng Việt tự nhiên; nếu người dùng viết tiếng Anh thì trả lời tiếng Anh chuẩn.
- Hỗ trợ Markdown gọn gàng (**in đậm**, danh sách gạch đầu dòng, tiêu đề ngắn) để hiển thị đẹp trên điện thoại.
- Không bịa địa chỉ, giá cả hoặc giờ mở cửa. Nếu là ước lượng, ghi rõ "tham khảo".
- Không tuyên bố nhớ người dùng vĩnh viễn; chỉ dựa trên ngữ cảnh phiên hiện tại và dữ liệu người dùng gửi.
- Trả lời súc tích, thực tế, có ích ngay.`;
}

async function handleGroqChat({ apiKeys, messages, locationContext, lastScan, weatherSummary }) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const web = await searchWebContextForChat(lastUserMsg, lastScan);
  const systemPrompt = buildSmartChatSystemPrompt({
    locationContext,
    lastScan,
    webContext: web.text,
    weatherSummary
  });

  const chatMessages = [{ role: "system", content: systemPrompt }, ...messages.slice(-10)];

  for (const apiKey of apiKeys.slice(0, 2)) {
    let models;
    try {
      models = await fetchWorkingGroqModels(apiKey);
    } catch (_) {
      continue;
    }
    const sortedModels = [
      ...models.filter((m) => /llama-3\.3-70b|gpt-oss-120b|qwen3\.8|qwen-2\.5-32b/i.test(m)),
      ...models.filter((m) => /llama-3\.1|gpt-oss-20b|qwen/i.test(m))
    ];
    for (const model of [...new Set(sortedModels)].slice(0, 2)) {
      try {
        const chatPayload = { model, temperature: 0.35, max_completion_tokens: 900, messages: chatMessages };
        if (/qwen3/i.test(model)) chatPayload.reasoning_effort = "none";

        const res = await fetchWithTimeout(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(chatPayload)
          },
          CONFIG.CHAT_TIMEOUT_MS
        );
        if (res.status === 429) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
          break;
        }
        if (res.status === 401 || res.status === 403) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
          break;
        }
        if (!res.ok) continue;
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        if (reply) return { reply, sources: web.places, provider: "groq" };
      } catch (_) {}
    }
  }
  throw new Error("Groq chat unavailable");
}

async function handleOpenRouterBackupChat({ apiKeys, messages, locationContext, lastScan, weatherSummary }) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const web = await searchWebContextForChat(lastUserMsg, lastScan);
  const systemPrompt = buildSmartChatSystemPrompt({
    locationContext,
    lastScan,
    webContext: web.text,
    weatherSummary
  });
  const chatMessages = [{ role: "system", content: systemPrompt }, ...messages.slice(-10)];

  for (const model of CONFIG.OPENROUTER_CHAT_MODELS) {
    for (const apiKey of apiKeys.slice(0, 2)) {
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
              temperature: 0.35,
              max_tokens: 900,
              reasoning: { enabled: false },
              provider: { sort: "throughput" },
              messages: chatMessages
            })
          },
          CONFIG.CHAT_TIMEOUT_MS
        );
        if (res.status === 429) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
          break;
        }
        if (!res.ok) continue;
        const data = await res.json();
        const msgObj = data.choices?.[0]?.message || {};
        const reply = String(msgObj.content || msgObj.reasoning || "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim();
        if (reply) return { reply, sources: web.places, provider: "openrouter" };
      } catch (_) {}
    }
  }
  throw new Error("Trợ lý tạm thời bận, bạn thử gửi lại sau vài giây nhé.");
}

// ==========================================
// HOÀI MY NEURAL TTS (PRESERVED EXACTLY VIA NODE TLS + CACHE)
// ==========================================
function cleanTtsText(rawText) {
  return String(rawText || "")
    .replace(/[*#_•~`]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.MAX_TTS_CHARS);
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateSecMsGec(trustedToken) {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + 11644473600n;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  return crypto.createHash("sha256").update(`${ticks.toString()}${trustedToken}`, "ascii").digest("hex").toUpperCase();
}

function createWsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function generateHoaiMyBase64(cleanText) {
  return new Promise((resolve, reject) => {
    const trustedToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    const connId = crypto.randomBytes(16).toString("hex");
    const reqId = crypto.randomBytes(16).toString("hex");
    const secMsGec = generateSecMsGec(trustedToken);
    const wsKey = crypto.randomBytes(16).toString("base64");

    const path =
      `/consumer/speech/synthesize/readaloud/edge/v1` +
      `?TrustedClientToken=${trustedToken}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=1-143.0.3650.66` +
      `&ConnectionId=${connId}`;

    const socket = tls.connect(443, "speech.platform.bing.com", { servername: "speech.platform.bing.com" });
    let done = false;
    let upgraded = false;
    let recvBuf = Buffer.alloc(0);
    let lastOpcode = 0x1;
    const audioChunks = [];

    const timer = setTimeout(() => finish(new Error("HoaiMy timeout")), CONFIG.TTS_TIMEOUT_MS);

    function finish(err, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    }

    socket.on("secureConnect", () => {
      const handshake = [
        `GET ${path} HTTP/1.1`,
        "Host: speech.platform.bing.com",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${wsKey}`,
        "Sec-WebSocket-Version: 13",
        "Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        "Pragma: no-cache",
        "Cache-Control: no-cache",
        "\r\n"
      ].join("\r\n");
      socket.write(handshake);
    });

    socket.on("data", (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      if (!upgraded) {
        const headerEnd = recvBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = recvBuf.slice(0, headerEnd).toString("utf8");
        if (!headerText.includes("101")) return finish(new Error("Edge TTS blocked"));
        upgraded = true;
        recvBuf = recvBuf.slice(headerEnd + 4);

        const ts = new Date().toString();
        const configMsg =
          `X-Timestamp:${ts}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;

        const ssmlMsg =
          `X-RequestId:${reqId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${ts}\r\n` +
          `Path:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
          `<voice name='vi-VN-HoaiMyNeural'>` +
          `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(cleanText)}</prosody>` +
          `</voice></speak>`;

        socket.write(createWsFrame(configMsg, 0x1));
        socket.write(createWsFrame(ssmlMsg, 0x1));
      }

      while (recvBuf.length >= 2) {
        const rawOpcode = recvBuf[0] & 0x0f;
        const opcode = rawOpcode === 0x0 ? lastOpcode : rawOpcode;
        if (rawOpcode === 0x1 || rawOpcode === 0x2) lastOpcode = rawOpcode;
        const masked = (recvBuf[1] & 0x80) !== 0;
        let payloadLen = recvBuf[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (recvBuf.length < 4) return;
          payloadLen = recvBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (recvBuf.length < 10) return;
          payloadLen = Number(recvBuf.readBigUInt64BE(2));
          offset = 10;
        }
        if (masked) offset += 4;
        if (recvBuf.length < offset + payloadLen) return;

        const payload = recvBuf.slice(offset, offset + payloadLen);
        recvBuf = recvBuf.slice(offset + payloadLen);

        if (opcode === 0x1) {
          if (payload.toString("utf8").includes("Path:turn.end")) {
            return audioChunks.length > 0
              ? finish(null, Buffer.concat(audioChunks).toString("base64"))
              : finish(new Error("Empty audio"));
          }
        } else if (opcode === 0x2 && payload.length > 2) {
          if (rawOpcode === 0x2) {
            const headerLen = payload.readUInt16BE(0);
            const headerStr = payload.slice(2, 2 + headerLen).toString("utf8");
            if (headerStr.includes("Path:audio")) audioChunks.push(payload.slice(2 + headerLen));
          } else {
            audioChunks.push(payload);
          }
        } else if (rawOpcode === 0x9) {
          socket.write(createWsFrame(payload, 0xa));
        } else if (rawOpcode === 0x8) {
          return audioChunks.length > 0
            ? finish(null, Buffer.concat(audioChunks).toString("base64"))
            : finish(new Error("Closed"));
        }
      }
    });

    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!done) {
        if (audioChunks.length > 0) finish(null, Buffer.concat(audioChunks).toString("base64"));
        else finish(new Error("Socket closed"));
      }
    });
  });
}

function splitTextForMp3(text, maxLen = 175) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    const part = s.trim();
    if (!part) continue;
    if ((current + " " + part).trim().length <= maxLen) {
      current = (current + " " + part).trim();
    } else {
      if (current) chunks.push(current);
      if (part.length <= maxLen) current = part;
      else {
        const words = part.split(/\s+/);
        let temp = "";
        for (const w of words) {
          if ((temp + " " + w).trim().length <= maxLen) temp = (temp + " " + w).trim();
          else {
            if (temp) chunks.push(temp);
            temp = w;
          }
        }
        current = temp;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 8);
}

async function generateBackupMp3Base64(cleanText) {
  const chunks = splitTextForMp3(cleanText, 175);
  const buffers = await Promise.all(
    chunks.map(async (chunk) => {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=${encodeURIComponent(chunk)}`;
      const res = await fetchWithTimeout(
        url,
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } },
        3000
      );
      if (!res.ok) throw new Error(`Backup TTS HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    })
  );
  return Buffer.concat(buffers).toString("base64");
}

async function generateVoiceBase64(rawText) {
  const cleanText = cleanTtsText(rawText);
  if (!cleanText) return null;
  const cacheKey = `tts:${hashShort(cleanText)}`;
  const cached = getCache(runtimeState.ttsCache, cacheKey);
  if (cached) return cached;

  return runSingleFlight(cacheKey, async () => {
    let audio = null;
    try {
      audio = await generateHoaiMyBase64(cleanText);
    } catch (_) {}
    if (!audio) audio = await generateBackupMp3Base64(cleanText);
    if (audio) setCache(runtimeState.ttsCache, cacheKey, audio, CONFIG.TTS_CACHE_TTL_MS, 60);
    return audio;
  });
}

// ==========================================
// ENTRY POINT SERVERLESS HANDLER
// ==========================================
module.exports = async (req, res) => {
  applySecurityHeaders(req, res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Lightweight non-secret config health check
  if (req.method === "GET" && req.query?.mode === "status") {
    return res.status(200).json({ ok: true, version: "2.0.0", services: getServiceStatus() });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Phương thức không được hỗ trợ." });
  }

  const body = parseJsonBody(req);
  if (!body) {
    return res.status(400).json({ error: "Dữ liệu JSON gửi lên không hợp lệ." });
  }

  const mode = String(body.mode || "scan").toLowerCase();

  try {
    // 1. TTS (Hoài My Neural)
    if (mode === "tts") {
      if (!(await enforceRateLimit(req, res, { scope: "tts", maxRequests: 18, windowSec: 60 }))) return;
      const text = sanitizeText(body.text, LIMITS.MAX_TTS_CHARS);
      if (!text) return res.status(400).json({ ttsError: "Nội dung đọc không được để trống." });

      try {
        const audioBase64 = await generateVoiceBase64(text);
        if (audioBase64) return res.status(200).json({ audioBase64 });
        return res.status(502).json({ ttsError: "Không tạo được dữ liệu âm thanh lúc này." });
      } catch (_) {
        return res.status(502).json({ ttsError: "Dịch vụ giọng đọc đang bận, bạn thử lại sau giây lát." });
      }
    }

    // 2. Service status via POST
    if (mode === "status") {
      return res.status(200).json({ ok: true, version: "2.0.0", services: getServiceStatus() });
    }

    const groqKeys = collectApiKeys("GROQ_API_KEY");
    const openRouterKeys = collectApiKeys("OPENROUTER_API_KEY");

    if (!groqKeys.length && !openRouterKeys.length) {
      return res.status(503).json({
        error: "Hệ thống chưa được cấu hình khóa AI (GROQ_API_KEY hoặc OPENROUTER_API_KEY) trên Vercel.",
        code: "MISSING_API_KEY",
        missingEnv: ["GROQ_API_KEY", "OPENROUTER_API_KEY"]
      });
    }

    // 3. AI ASSISTANT CHAT
    if (mode === "chat") {
      if (!(await enforceRateLimit(req, res, { scope: "chat", maxRequests: 20, windowSec: 60 }))) return;
      const validated = validateChatMessages(body.messages);
      if (!validated.valid) return res.status(400).json({ error: validated.error });

      const locationContext = sanitizeText(body.locationContext, 200);
      const weatherSummary = sanitizeText(body.weatherSummary, 240);

      if (groqKeys.length) {
        try {
          const out = await handleGroqChat({
            apiKeys: groqKeys,
            messages: validated.messages,
            locationContext,
            lastScan: body.lastScan,
            weatherSummary
          });
          return res.status(200).json(out);
        } catch (_) {}
      }
      if (openRouterKeys.length) {
        const out = await handleOpenRouterBackupChat({
          apiKeys: openRouterKeys,
          messages: validated.messages,
          locationContext,
          lastScan: body.lastScan,
          weatherSummary
        });
        return res.status(200).json(out);
      }
      return res.status(503).json({ error: "Trợ lý AI đang tạm bận, bạn thử gửi lại sau vài giây nhé." });
    }

    // 4. AI PHOTO COMPARE (2 IMAGES)
    if (mode === "compare") {
      if (!(await enforceRateLimit(req, res, { scope: "compare", maxRequests: 8, windowSec: 60 }))) return;
      const img1 = validateImageBase64(body.imageBase64A);
      const img2 = validateImageBase64(body.imageBase64B);
      if (!img1.valid || !img2.valid) {
        return res.status(400).json({ error: img1.error || img2.error || "Cần 2 hình ảnh hợp lệ để so sánh." });
      }

      const deadline = Date.now() + CONFIG.TOTAL_SCAN_BUDGET_MS;
      const prompt = buildComparePrompt(sanitizeText(body.locationContext, 160));
      const imageUrls = [img1.dataUrl, img2.dataUrl];

      let out = null;
      if (groqKeys.length) {
        try {
          out = await runGroqPrimaryVision({ apiKeys: groqKeys, prompt, imageUrls, deadline: Date.now() + 7000 });
        } catch (_) {}
      }
      if (!out && openRouterKeys.length) {
        out = await runOpenRouterBackupVision({ apiKeys: openRouterKeys, prompt, imageUrls, deadline });
      }
      if (!out) {
        return res.status(502).json({ error: "Không thể so sánh hai ảnh lúc này. Bạn thử lại nhé!" });
      }
      return res.status(200).json({ ...out.result, _provider: out.provider });
    }

    // 5. DEFAULT: MULTI-MODE AI VISION SCANNER (10 MODES)
    if (!(await enforceRateLimit(req, res, { scope: "scan", maxRequests: 12, windowSec: 60 }))) return;
    const imgCheck = validateImageBase64(body.imageBase64);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: imgCheck.error });
    }

    const scanMode = SCAN_MODE_HINTS[body.scanMode] ? body.scanMode : "auto";
    const locationContext = sanitizeText(body.locationContext, 240);
    const lat = body.lat;
    const lng = body.lng;

    const imgKey = `scan:${scanMode}:${hashShort(imgCheck.dataUrl)}`;
    const cachedScan = getCache(runtimeState.scanCache, imgKey);
    if (cachedScan) {
      return res.status(200).json({ ...cachedScan, _cached: true });
    }

    const finalPayload = await runSingleFlight(imgKey, async () => {
      const deadline = Date.now() + CONFIG.TOTAL_SCAN_BUDGET_MS;
      const areaPoint = clampToDaNangHoiAn(lat, lng, locationContext);
      const prompt = buildVisionPrompt(locationContext, scanMode);

      let visionOutput = null;
      let groqError = null;

      if (groqKeys.length) {
        const groqBudgetMs = openRouterKeys.length ? 6500 : 10000;
        try {
          visionOutput = await runGroqPrimaryVision({
            apiKeys: groqKeys,
            prompt,
            imageUrls: [imgCheck.dataUrl],
            deadline: Math.min(deadline, Date.now() + groqBudgetMs)
          });
        } catch (err) {
          groqError = err;
        }
      }

      if (!visionOutput) {
        if (openRouterKeys.length && deadline - Date.now() >= 1500) {
          try {
            visionOutput = await runOpenRouterBackupVision({
              apiKeys: openRouterKeys,
              prompt,
              imageUrls: [imgCheck.dataUrl],
              deadline
            });
          } catch (orErr) {
            const combined = new Error("ALL_VISION_FAILED");
            combined.isRateLimit = Boolean(groqError?.isRateLimit || orErr?.isRateLimit);
            combined.isOverloaded = Boolean(groqError?.isOverloaded || orErr?.isOverloaded);
            throw combined;
          }
        } else if (groqError) {
          throw groqError;
        } else {
          throw new Error("NO_VISION_PROVIDER");
        }
      }

      let payload = normalizeScanResult(visionOutput.result, {
        areaPoint,
        locationContext,
        provider: visionOutput.provider,
        scanMode
      });
      if (payload.error) return payload;

      const timeLeftForSerper = deadline - Date.now();
      if (timeLeftForSerper >= 800 && scanMode !== "ocr") {
        payload = await autoVerifyWithGoogle(payload, {
          areaPoint,
          locationContext,
          timeoutMs: Math.min(CONFIG.SERPER_TIMEOUT_MS, timeLeftForSerper - 100)
        });
      }

      setCache(runtimeState.scanCache, imgKey, payload, CONFIG.SCAN_CACHE_TTL_MS, 100);
      return payload;
    });

    if (finalPayload.error) return res.status(422).json(finalPayload);
    return res.status(200).json(finalPayload);
  } catch (err) {
    const status = err?.isRateLimit ? 429 : err?.isOverloaded ? 503 : 502;
    const message = err?.isRateLimit
      ? "Hệ thống đang có nhiều lượt quét cùng lúc. Bạn đợi 5–10 giây rồi thử lại nhé!"
      : err?.isOverloaded
      ? "Máy chủ AI đang quá tải tạm thời. Bạn bấm Quét lại sau 3–5 giây nhé!"
      : CONFIG.FRIENDLY_ERROR;

    return res.status(status).json({ error: message });
  }
};
