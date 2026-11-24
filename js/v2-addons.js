/**
 * AIvolution 2.0 — Additive Feature Engine (Non-Destructive)
 * Preserves 100% of original app.js UI, icons & animations while powering:
 * - IndexedDB storage & legacy localStorage sync/migration + Favorites + Saved Plans + JSON Backup
 * - Explore Map modal (Leaflet + 8 categories + 500m..10km + rating/search + GPS fallback)
 * - AI Travel Planner modal (day-by-day + budget warning + route optimizer + Trip Journal)
 * - AI Photo Compare modal (2-image comparison)
 * - Service configuration health check & Toast notifications
 */
(function initAIvolutionV2Addons() {
  "use strict";

  const SESSION_KEY = "aivolution_session_v2";
  function getSessionId() {
    try {
      let s = sessionStorage.getItem(SESSION_KEY);
      if (!s || !/^[a-zA-Z0-9_-]{8,64}$/.test(s)) {
        const b = new Uint8Array(12);
        crypto.getRandomValues(b);
        s = "aiv2_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        sessionStorage.setItem(SESSION_KEY, s);
      }
      return s;
    } catch (_) {
      return "aiv2_session_fallback";
    }
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    try {
      const u = new URL(s, window.location.origin);
      return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
    } catch (_) {
      return "";
    }
  }

  function formatVnd(n) {
    return `${Math.round(Number(n) || 0).toLocaleString("vi-VN")}đ`;
  }

  function formatDist(m) {
    const n = Number(m);
    if (!Number.isFinite(n)) return "";
    return n < 1000 ? `${Math.round(n)}m` : `${(n / 1000).toFixed(1)}km`;
  }

  let toastTimer = null;
  function showToast(msg) {
    let el = document.getElementById("v2Toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "v2Toast";
      el.className = "v2-toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function renderSafeMarkdown(rawText) {
    const escaped = esc(rawText);
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let inList = false;
    const inline = (line) =>
      line
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
          const su = safeUrl(url);
          return su ? `<a href="${esc(su)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
        });

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (inList) { out.push("</ul>"); inList = false; }
        continue;
      }
      if (/^[-•*]\s+/.test(line)) {
        if (!inList) { out.push('<ul style="margin:4px 0;padding-left:18px">'); inList = true; }
        out.push(`<li>${inline(line.replace(/^[-•*]\s+/, ""))}</li>`);
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(`<p style="margin:0 0 6px">${inline(line)}</p>`);
      }
    }
    if (inList) out.push("</ul>");
    return out.join("");
  }

  // ==========================================
  // 1. INDEXEDDB STORAGE LAYER (SCANS, FAVORITES, PLANS, REPORTS)
  // ==========================================
  const DB_NAME = "AIvolutionDB";
  const DB_VERSION = 2;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("No IndexedDB"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        ["scans", "collections", "chats", "itineraries", "reports"].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbPut(storeName, record) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {
      return false;
    }
  }

  async function idbGetAll(storeName) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (_) {
      return [];
    }
  }

  async function idbDelete(storeName, id) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}
  }

  async function idbClear(storeName) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}
  }

  // Expose lightweight bridge for app.js hooks
  window.AIv2 = {
    getSessionId,
    showToast,
    renderSafeMarkdown,
    safeUrl,
    saveFavorite: async (item) => {
      await idbPut("collections", {
        id: item.id || `fav_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        createdAt: Date.now(),
        ...item
      });
      showToast("Đã lưu vào Bộ sưu tập cá nhân!");
      renderHistoryExtras();
    },
    mirrorScanToIdb: async (item) => {
      if (item && item.id) await idbPut("scans", { ...item, id: String(item.id), createdAt: Date.now() });
    },
    clearIdbScans: async () => {
      await idbClear("scans");
      renderHistoryExtras();
    },
    saveReport: async (report) => {
      await idbPut("reports", { id: `rep_${Date.now()}`, createdAt: Date.now(), ...report });
      showToast("Đã ghi nhận báo cáo nhận diện sai!");
    },
    askChat: (promptText) => {
      if (typeof window.navigateTo === "function") window.navigateTo("chat");
      const input = document.getElementById("chatInput");
      const form = document.getElementById("chatForm");
      if (input && form) {
        input.value = promptText;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    }
  };

  // ==========================================
  // 2. EXPLORE MAP MODAL (8 CATEGORIES + 500M..10KM + LEAFLET)
  // ==========================================
  const MAP_CATS = [
    { id: "all", label: "Tất cả" },
    { id: "restaurant", label: "Nhà hàng" },
    { id: "cafe", label: "Cà phê" },
    { id: "hotel", label: "Khách sạn" },
    { id: "tourism", label: "Du lịch" },
    { id: "minimart", label: "Siêu thị" },
    { id: "atm", label: "ATM" },
    { id: "pharmacy", label: "Hiệu thuốc" }
  ];
  const MAP_RADII = [500, 1000, 2000, 3000, 5000, 10000];

  function initExploreMapModal() {
    const openBtn = document.getElementById("v2-map-open-btn");
    const modal = document.getElementById("v2MapModal");
    if (!openBtn || !modal) return;

    let category = "all";
    let radius = 1000;
    let minRating = 0;
    let keyword = "";
    let coords = null;
    let mapInst = null;
    let layerInst = null;

    const catRow = document.getElementById("v2MapCats");
    const radRow = document.getElementById("v2MapRadii");
    const statusEl = document.getElementById("v2MapStatus");
    const listEl = document.getElementById("v2MapList");
    const mapCanvas = document.getElementById("v2LeafletBox");

    function renderFilterChips() {
      if (catRow) {
        catRow.innerHTML = MAP_CATS.map(
          (c) => `<button type="button" class="v2-chip ${c.id === category ? "active" : ""}" data-mc="${c.id}">${esc(c.label)}</button>`
        ).join("");
        catRow.querySelectorAll("[data-mc]").forEach((b) =>
          b.addEventListener("click", () => {
            category = b.dataset.mc;
            renderFilterChips();
            loadPlaces();
          })
        );
      }
      if (radRow) {
        radRow.innerHTML = MAP_RADII.map(
          (r) => `<button type="button" class="v2-chip ${r === radius ? "active" : ""}" data-mr="${r}">${formatDist(r)}</button>`
        ).join("");
        radRow.querySelectorAll("[data-mr]").forEach((b) =>
          b.addEventListener("click", () => {
            radius = Number(b.dataset.mr);
            renderFilterChips();
            loadPlaces();
          })
        );
      }
    }

    function updateMap(center, items) {
      if (!mapCanvas || typeof window.L === "undefined") return;
      if (!mapInst) {
        mapInst = window.L.map(mapCanvas).setView([center.lat, center.lng], 14);
        window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mapInst);
        layerInst = window.L.layerGroup().addTo(mapInst);
      } else {
        mapInst.setView([center.lat, center.lng], radius <= 1000 ? 15 : radius <= 3000 ? 14 : 12);
        setTimeout(() => mapInst.invalidateSize(), 150);
      }
      layerInst.clearLayers();
      window.L.circleMarker([center.lat, center.lng], { radius: 7, color: "#94D82D", fillColor: "#94D82D", fillOpacity: 0.9 }).addTo(layerInst);
      items.slice(0, 25).forEach((p) => {
        if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
          window.L.marker([p.lat, p.lng]).bindPopup(`<strong>${esc(p.name)}</strong><br/>${formatDist(p.distance)}`).addTo(layerInst);
        }
      });
    }

    function resolveCoords(forceGps) {
      return new Promise((resolve) => {
        if (!forceGps && coords) return resolve(coords);
        if (!navigator.geolocation) {
          coords = { lat: 16.0544, lng: 108.2022, label: "Đà Nẵng (Mặc định)" };
          return resolve(coords);
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            coords = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "Vị trí GPS của bạn" };
            resolve(coords);
          },
          () => {
            coords = coords || { lat: 16.0544, lng: 108.2022, label: "Đà Nẵng (Chưa cấp GPS)" };
            resolve(coords);
          },
          { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
        );
      });
    }

    async function loadPlaces(forceGps = false) {
      if (statusEl) statusEl.textContent = "Đang tải địa điểm...";
      if (listEl) listEl.innerHTML = `<div class="v2-card"><p class="v2-muted">Đang quét bản đồ...</p></div>`;
      const pt = await resolveCoords(forceGps);
      try {
        const qs = new URLSearchParams({
          lat: String(pt.lat),
          lng: String(pt.lng),
          radius: String(radius),
          category
        });
        if (minRating > 0) qs.set("minRating", String(minRating));
        if (keyword) qs.set("q", keyword);

        const res = await fetch(`/api/nearby-places?${qs.toString()}`, {
          headers: { "X-AIvolution-Session": getSessionId() }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Không tải được địa điểm.");

        const places = data.places || [];
        if (statusEl) {
          statusEl.textContent = `${places.length} địa điểm • ${formatDist(radius)} • ${pt.label}${data.notice ? ` (${data.notice})` : ""}`;
        }
        updateMap(pt, places);

        if (!places.length) {
          listEl.innerHTML = `<div class="v2-card"><p>Không tìm thấy địa điểm phù hợp trong bán kính ${formatDist(radius)}. Hãy thử tăng bán kính lên 5km hoặc 10km.</p></div>`;
          return;
        }
        listEl.innerHTML = places
          .map((p, idx) => {
            const su = safeUrl(p.mapsUrl) || "#";
            return `
            <div class="v2-card">
              <h4>${esc(p.name)}</h4>
              <p class="v2-muted">${p.rating > 0 ? `★ ${p.rating.toFixed(1)} (${p.reviews}) • ` : ""}${formatDist(p.distance)} • ${esc(p.type)}</p>
              ${p.address ? `<p>📍 ${esc(p.address)}</p>` : ""}
              <div class="v2-row-wrap" style="margin-top:8px">
                <a class="v2-btn lime" href="${esc(su)}" target="_blank" rel="noopener noreferrer">Chỉ đường</a>
                <button type="button" class="v2-btn" data-msave="${idx}">🔖 Lưu</button>
                <button type="button" class="v2-btn" data-mask="${idx}">Hỏi AI</button>
              </div>
            </div>`;
          })
          .join("");

        listEl.querySelectorAll("[data-msave]").forEach((b) =>
          b.addEventListener("click", () => {
            const p = places[Number(b.dataset.msave)];
            if (p) window.AIv2.saveFavorite({ type: "place", title: p.name, subtitle: p.address || p.type, url: safeUrl(p.mapsUrl) });
          })
        );
        listEl.querySelectorAll("[data-mask]").forEach((b) =>
          b.addEventListener("click", () => {
            const p = places[Number(b.dataset.mask)];
            if (p) {
              modal.hidden = true;
              window.AIv2.askChat(`Review nhanh "${p.name}" (${p.type}, ${p.address || "Đà Nẵng - Hội An"}): có gì nổi bật và giá tham khảo?`);
            }
          })
        );
      } catch (err) {
        if (listEl) listEl.innerHTML = `<div class="v2-card"><p>${esc(err.message)}</p></div>`;
      }
    }

    renderFilterChips();
    openBtn.addEventListener("click", () => {
      modal.hidden = false;
      loadPlaces(false);
    });
    modal.querySelectorAll("[data-v2-close]").forEach((el) => el.addEventListener("click", () => { modal.hidden = true; }));
    document.getElementById("v2MapGpsBtn")?.addEventListener("click", () => loadPlaces(true));
    document.getElementById("v2MapDnBtn")?.addEventListener("click", () => { coords = { lat: 16.0544, lng: 108.2022, label: "Đà Nẵng" }; loadPlaces(false); });
    document.getElementById("v2MapHaBtn")?.addEventListener("click", () => { coords = { lat: 15.8801, lng: 108.3380, label: "Hội An" }; loadPlaces(false); });
    document.getElementById("v2MapRating")?.addEventListener("change", (e) => { minRating = Number(e.target.value) || 0; loadPlaces(false); });
    document.getElementById("v2MapSearchForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      keyword = (document.getElementById("v2MapSearchInput")?.value || "").trim();
      loadPlaces(false);
    });
  }

  // ==========================================
  // 3. AI TRAVEL PLANNER MODAL
  // ==========================================
  function initTravelPlannerModal() {
    const openBtn = document.getElementById("v2-planner-open-btn");
    const modal = document.getElementById("v2PlannerModal");
    const form = document.getElementById("v2PlannerForm");
    const out = document.getElementById("v2PlannerResult");
    if (!openBtn || !modal || !form || !out) return;

    function renderPlan(plan) {
      out.innerHTML = `
        <div class="v2-card">
          <h4>${esc(plan.title)}</h4>
          <p>${esc(plan.summary || "")}</p>
          <div class="${plan.overBudget ? "v2-budget-over" : "v2-budget-ok"}" style="margin:8px 0">${esc(plan.budgetWarning)}</div>
          <p class="v2-muted">🧭 ${esc(plan.routeNote || "")}</p>
          <div class="v2-row-wrap" style="margin-top:8px">
            <button type="button" id="v2SavePlanBtn" class="v2-btn lime">💾 Lưu lịch trình</button>
            <button type="button" id="v2SharePlanBtn" class="v2-btn">📤 Chia sẻ</button>
          </div>
        </div>
        ${(plan.days || [])
          .map(
            (d) => `
          <div class="v2-card">
            <h4>Ngày ${d.day}: ${esc(d.theme)} (${formatVnd(d.dayCostVnd)})</h4>
            ${(d.slots || [])
              .map((s) => {
                const su = safeUrl(s.mapsUrl) || "#";
                return `
                <div style="padding:8px 0;border-top:1px solid rgba(128,128,128,0.14)">
                  <strong>${esc(s.period)} (${esc(s.timeRange)}): ${esc(s.placeName)}</strong> — <span class="v2-muted">~${formatVnd(s.estimatedCostVnd)}</span>
                  <p>${esc(s.activity)} (${esc(s.duration)}) • 📍 ${esc(s.address)}</p>
                  <div class="v2-row-wrap" style="margin-top:4px">
                    <span class="v2-muted">${esc(s.sourceNote)}</span>
                    <a class="v2-btn" href="${esc(su)}" target="_blank" rel="noopener noreferrer">Maps</a>
                  </div>
                </div>`;
              })
              .join("")}
          </div>`
          )
          .join("")}
      `;
      document.getElementById("v2SavePlanBtn")?.addEventListener("click", async () => {
        await idbPut("itineraries", plan);
        showToast("Đã lưu lịch trình vào Lịch sử!");
        renderHistoryExtras();
      });
      document.getElementById("v2SharePlanBtn")?.addEventListener("click", async () => {
        const text = `${plan.title}\nNgân sách: ${formatVnd(plan.budgetVnd)} | Ước tính: ${formatVnd(plan.totalEstimatedVnd)}`;
        if (navigator.share) await navigator.share({ title: plan.title, text }).catch(() => {});
        else if (navigator.clipboard) { await navigator.clipboard.writeText(text); showToast("Đã sao chép lịch trình!"); }
      });
    }

    openBtn.addEventListener("click", () => { modal.hidden = false; });
    modal.querySelectorAll("[data-v2-close]").forEach((el) => el.addEventListener("click", () => { modal.hidden = true; }));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("v2PlanSubmitBtn");
      if (btn) { btn.disabled = true; btn.textContent = "Đang tạo lịch trình AI..."; }
      out.innerHTML = `<div class="v2-card"><p class="v2-muted">Đang tính toán lịch trình &amp; ngân sách...</p></div>`;
      try {
        const res = await fetch("/api/planner", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AIvolution-Session": getSessionId() },
          body: JSON.stringify({
            city: document.getElementById("v2PlanCity").value,
            days: Number(document.getElementById("v2PlanDays").value),
            budgetVnd: Number(document.getElementById("v2PlanBudget").value),
            people: Number(document.getElementById("v2PlanPeople").value),
            interests: document.getElementById("v2PlanInterests").value,
            travelType: document.getElementById("v2PlanType").value,
            transport: document.getElementById("v2PlanTransport").value
          })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Không tạo được lịch trình.");
        renderPlan(data);
      } catch (err) {
        out.innerHTML = `<div class="v2-card"><p style="color:#ef4444">${esc(err.message)}</p></div>`;
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Tạo lịch trình AI"; }
      }
    });
  }

  // ==========================================
  // 4. AI PHOTO COMPARE MODAL
  // ==========================================
  function initPhotoCompareModal() {
    const openBtn = document.getElementById("v2-compare-open-btn");
    const modal = document.getElementById("v2CompareModal");
    if (!openBtn || !modal) return;

    let imgA = null, imgB = null;
    function readImg(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => {
          const c = document.createElement("canvas");
          const s = Math.min(1, 960 / Math.max(im.naturalWidth, im.naturalHeight, 1));
          c.width = Math.round(im.naturalWidth * s);
          c.height = Math.round(im.naturalHeight * s);
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL("image/jpeg", 0.8));
        };
        im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Lỗi đọc ảnh")); };
        im.src = url;
      });
    }

    openBtn.addEventListener("click", () => { modal.hidden = false; });
    modal.querySelectorAll("[data-v2-close]").forEach((el) => el.addEventListener("click", () => { modal.hidden = true; }));

    document.getElementById("v2CmpFileA")?.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      imgA = await readImg(f);
      const p = document.getElementById("v2CmpPrevA");
      if (p) { p.src = imgA; p.hidden = false; }
    });
    document.getElementById("v2CmpFileB")?.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      imgB = await readImg(f);
      const p = document.getElementById("v2CmpPrevB");
      if (p) { p.src = imgB; p.hidden = false; }
    });

    document.getElementById("v2CmpRunBtn")?.addEventListener("click", async () => {
      const out = document.getElementById("v2CmpResult");
      if (!imgA || !imgB) return showToast("Vui lòng chọn đủ 2 ảnh!");
      if (out) out.innerHTML = `<div class="v2-card"><p class="v2-muted">Đang so sánh 2 ảnh...</p></div>`;
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AIvolution-Session": getSessionId() },
          body: JSON.stringify({ mode: "compare", imageBase64A: imgA, imageBase64B: imgB, locationContext: "Đà Nẵng – Hội An" })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Không so sánh được lúc này.");
        out.innerHTML = `
          <div class="v2-card">
            <h4>⚖️ ${esc(data.tieu_de || "Kết quả so sánh")}</h4>
            <p><strong>Ảnh 1 (${esc(data.anh_1?.ten || "")}):</strong> ${esc(data.anh_1?.diem_noi_bat || "")}</p>
            <p><strong>Ảnh 2 (${esc(data.anh_2?.ten || "")}):</strong> ${esc(data.anh_2?.diem_noi_bat || "")}</p>
            ${(data.diem_giong || []).length ? `<p><strong>Giống nhau:</strong> ${esc(data.diem_giong.join(" • "))}</p>` : ""}
            ${(data.diem_khac || []).length ? `<p><strong>Khác nhau:</strong> ${esc(data.diem_khac.join(" • "))}</p>` : ""}
            ${data.khuyen_nghi ? `<p><strong>Gợi ý:</strong> ${esc(data.khuyen_nghi)}</p>` : ""}
          </div>`;
      } catch (err) {
        if (out) out.innerHTML = `<div class="v2-card"><p style="color:#ef4444">${esc(err.message)}</p></div>`;
      }
    });
  }

  // ==========================================
  // 5. HISTORY EXTRAS (FAVORITES, SAVED PLANS, JSON BACKUP, API STATUS)
  // ==========================================
  async function renderHistoryExtras() {
    const box = document.getElementById("v2HistoryExtras");
    if (!box) return;
    const [favs, plans] = await Promise.all([idbGetAll("collections"), idbGetAll("itineraries")]);

    let healthHtml = `<span class="v2-muted">Đang kiểm tra trạng thái API...</span>`;
    try {
      const res = await fetch("/api/scan?mode=status");
      const st = await res.json();
      if (res.ok && st.services) {
        const s = st.services;
        healthHtml = `Groq: <strong>${s.groqConfigured ? "OK" : "Thiếu key"}</strong> • OpenRouter: <strong>${s.openRouterConfigured ? "OK" : "Chưa bật"}</strong> • Serper: <strong>${s.serperConfigured ? "OK" : "Dùng OSM"}</strong> • Redis RL: <strong>${s.redisRateLimitConfigured ? "OK" : "Dự phòng RAM"}</strong>`;
      }
    } catch (_) {}

    box.innerHTML = `
      <div class="v2-card" style="margin-top:16px">
        <h4>🔖 Bộ sưu tập đã lưu (${favs.length})</h4>
        ${
          favs.length
            ? favs
                .slice(0, 10)
                .map(
                  (f) => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px solid rgba(128,128,128,0.12)">
                <div>
                  <strong style="font-size:13px">${esc(f.title)}</strong>
                  <div class="v2-muted">${esc(f.subtitle || "")}</div>
                </div>
                <div class="v2-row-wrap">
                  ${safeUrl(f.url) ? `<a class="v2-btn" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener noreferrer">Mở</a>` : ""}
                  <button type="button" class="v2-btn danger" data-delfav="${esc(f.id)}">✕</button>
                </div>
              </div>`
                )
                .join("")
            : `<p class="v2-muted">Chưa có địa điểm hoặc món ăn yêu thích nào.</p>`
        }
      </div>

      <div class="v2-card" style="margin-top:10px">
        <h4>🧭 Lịch trình du lịch đã lưu (${plans.length})</h4>
        ${
          plans.length
            ? plans
                .slice(0, 6)
                .map(
                  (p) => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px solid rgba(128,128,128,0.12)">
                <div>
                  <strong style="font-size:13px">${esc(p.title)}</strong>
                  <div class="v2-muted">${p.daysCount} ngày • ~${formatVnd(p.totalEstimatedVnd)}</div>
                </div>
                <button type="button" class="v2-btn danger" data-delplan="${esc(p.id)}">✕</button>
              </div>`
                )
                .join("")
            : `<p class="v2-muted">Chưa có lịch trình nào. Mở Travel Planner ở Trang chủ để tạo!</p>`
        }
      </div>

      <div class="v2-card" style="margin-top:10px">
        <h4>⚙️ Bảo mật, API &amp; Sao lưu IndexedDB</h4>
        <p class="v2-muted" style="margin-bottom:8px">${healthHtml}</p>
        <div class="v2-row-wrap">
          <button type="button" id="v2ExportBtn" class="v2-btn lime">⬇ Xuất sao lưu JSON</button>
          <button type="button" id="v2ClearPersonalBtn" class="v2-btn danger">Xóa toàn bộ dữ liệu cá nhân</button>
        </div>
      </div>
    `;

    box.querySelectorAll("[data-delfav]").forEach((b) =>
      b.addEventListener("click", async () => {
        await idbDelete("collections", b.dataset.delfav);
        renderHistoryExtras();
      })
    );
    box.querySelectorAll("[data-delplan]").forEach((b) =>
      b.addEventListener("click", async () => {
        await idbDelete("itineraries", b.dataset.delplan);
        renderHistoryExtras();
      })
    );
    document.getElementById("v2ExportBtn")?.addEventListener("click", async () => {
      const bundle = {
        app: "AIvolution 2.0",
        exportedAt: new Date().toISOString(),
        scans: await idbGetAll("scans"),
        collections: await idbGetAll("collections"),
        itineraries: await idbGetAll("itineraries")
      };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = `aivolution-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(u);
      showToast("Đã tải tệp sao lưu JSON!");
    });
    let armed = false;
    document.getElementById("v2ClearPersonalBtn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!armed) {
        armed = true;
        btn.textContent = "Bấm lần nữa để xác nhận xóa";
        setTimeout(() => { armed = false; btn.textContent = "Xóa toàn bộ dữ liệu cá nhân"; }, 3000);
        return;
      }
      armed = false;
      await Promise.all(["scans", "collections", "chats", "itineraries", "reports"].map(idbClear));
      try {
        localStorage.removeItem("aivolution_scan_history_v1");
        localStorage.removeItem("aivolution_total_scans_v1");
      } catch (_) {}
      showToast("Đã xóa toàn bộ dữ liệu cá nhân!");
      window.location.reload();
    });
  }

  // Refresh extras when opening History tab
  document.getElementById("navHistoryBtn")?.addEventListener("click", () => {
    setTimeout(renderHistoryExtras, 80);
  });

  initExploreMapModal();
  initTravelPlannerModal();
  initPhotoCompareModal();
})();
