# AIvolution 2.0 — Hệ sinh thái AI Khám phá, Du lịch & Ẩm thực

AIvolution 2.0 là bản nâng cấp toàn diện trực tiếp trên nền tảng mã nguồn gốc **AIvolution** (Vercel Serverless Node.js + Vanilla ES Modules + PWA), bảo toàn 100% các tính năng cốt lõi đang hoạt động (Groq Vision, OpenRouter Free backup, Serper auto-verify, giọng đọc Hoài My Neural tối ưu iOS Safari, TWA Android `.well-known/assetlinks.json`) và mở rộng thành hệ sinh thái AI thực tế.

## Tính năng chính

### 1. AI Scanner 2.0 (10 chế độ nhận diện)
- **10 chế độ:** Tổng quát, Món ăn, Địa điểm, Kiến trúc, Sản phẩm, Đồ vật, Động vật, Thực vật, Biển báo, Đọc chữ (OCR) & Dịch.
- **Tính năng mở rộng:** Chụp camera trực tiếp (tối ưu iOS Safari), chọn 1 hoặc nhiều ảnh cùng lúc (batch tối đa 4 ảnh), **AI Photo Compare** (so sánh 2 hình ảnh), hiển thị độ tin cậy & nguồn xác minh (không tự bịa giá/địa chỉ), đọc thuyết minh Hoài My Neural, hỏi AI về ảnh vừa quét, lưu vào Bộ sưu tập, chia sẻ và báo cáo nhận diện sai.

### 2. AI Assistant (Trợ lý cá nhân)
- Giao diện bong bóng hỗ trợ Markdown an toàn XSS, thẻ nguồn tham khảo, nhớ kết quả quét gần nhất trong phiên, đọc giọng Hoài My Neural trên từng tin nhắn, sao chép, gợi ý hỏi tiếp, nhập bằng giọng nói (Web Speech API) và lưu lịch sử trò chuyện bằng IndexedDB.

### 3. Bản đồ Khám phá thông minh (Explore Map)
- Bản đồ tương tác Leaflet + liên kết chỉ đường Google Maps, xử lý lịch sự khi không cấp quyền GPS (chuyển sang chọn Đà Nẵng / Hội An, không theo dõi vị trí nền liên tục).
- **8 danh mục:** Tất cả, Nhà hàng, Cà phê, Khách sạn, Du lịch, Siêu thị, ATM, Hiệu thuốc.
- **6 mức bán kính:** `500m`, `1km`, `2km`, `3km`, `5km`, `10km`, lọc theo đánh giá sao & tìm theo tên.

### 4. AI Travel Planner & Trip Journal
- Nhập thành phố, số ngày (1–7), ngân sách (VNĐ), số người, sở thích, loại hình & phương tiện.
- Tạo lịch trình theo từng ngày (Sáng/Trưa/Chiều/Tối), tối ưu cụm địa điểm gần nhau, tính tổng chi phí dự kiến, cảnh báo khi vượt ngân sách, lưu IndexedDB, chia sẻ lịch trình và ghi Nhật ký chuyến đi.

### 5. Food & Drinks, News Center, Smart Weather & Personal Collection
- **Food & Drinks:** 8 danh mục ẩm thực, tách rõ nhãn nguồn dữ liệu (`Tin thực tế` vs `Danh mục tham khảo`), gợi ý món ăn theo ngân sách & sở thích.
- **News Center:** 7 nhóm tin tức (Đà Nẵng, Hội An, Du lịch, Ẩm thực, Sự kiện, Văn hóa, Công nghệ AI), lọc trùng lặp, loại tin quá cũ, có trạng thái lỗi RSS rõ ràng.
- **Smart Weather:** Dữ liệu Open-Meteo (nhiệt độ, cảm giác như, độ ẩm, gió, khả năng mưa, dự báo 24h & 7 ngày) kèm gợi ý hoạt động trong nhà/ngoài trời, đi biển và đồ cần mang.
- **Personal Collection & IndexedDB:** Tự động di chuyển lịch sử cũ từ `localStorage` sang `IndexedDB`, quản lý dung lượng, sao lưu/khôi phục JSON, xóa lịch sử và xóa toàn bộ dữ liệu cá nhân (xác nhận 2 chạm, không dùng `confirm()`).

## Kiến trúc & Bảo mật
- **API Endpoints:**
  - `POST /api/scan` (giữ nguyên tương thích: `scan`, `chat`, `tts`, bổ sung `compare`, `status`)
  - `GET /api/nearby-places` (mở rộng bán kính 10km, 9 danh mục, dự phòng OpenStreetMap)
  - `GET /api/explore` (giữ nguyên `tab=news|food|checkin`, bổ sung lọc `category`)
  - `POST /api/planner` (AI Travel Planner)
  - `GET /api/search` (Tìm kiếm tổng hợp)
  - `GET /api/weather` (Thời tiết thông minh)
- **Bảo mật (`api/_lib/security.js` & `vercel.json`):**
  - Rate limiting theo IP + Session (hỗ trợ **Upstash Redis REST** xuyên nhiều instance serverless, tự động dự phòng bộ nhớ khi chưa cấu hình Redis).
  - Kiểm tra chữ ký định dạng ảnh thực tế (magic bytes JPEG/PNG/WebP/GIF) và giới hạn 4MB.
  - Không trả lỗi debug nội bộ xuống người dùng, kiểm tra URL chống XSS (`javascript:`/`data:`), Security Headers chuẩn (CSP, HSTS, X-Frame-Options, nosniff, Permissions-Policy).
- **PWA (`sw.js`, `manifest.json`, `offline.html`):** Cache tĩnh theo phiên bản, trang ngoại tuyến riêng, tuyệt đối không cache `/api/*` hay dữ liệu cá nhân.

## Hướng dẫn Deploy lên Vercel

1. Giải nén thư mục dự án và đẩy lên repository GitHub của bạn (hoặc import trực tiếp vào Vercel).
2. Vào **Vercel Dashboard → Project → Settings → Environment Variables**, thêm các biến từ `.env.example`:
   - `GROQ_API_KEY` (bắt buộc để chạy AI Scanner, AI Assistant, Travel Planner)
   - `OPENROUTER_API_KEY` (khuyến nghị làm dự phòng miễn phí)
   - `SERPER_API_KEY` (khuyến nghị để lấy đánh giá Google Maps & tự xác minh giá/địa chỉ)
   - `UPSTASH_REDIS_REST_URL` và `UPSTASH_REDIS_REST_TOKEN` (khuyến nghị để bật Rate Limit phân tán)
3. Nhấn **Deploy** (không cần bước build hay cài đặt `node_modules`).
4. Sau khi deploy, mở tab **Profile → Trạng thái API & Bảo mật** trong ứng dụng để kiểm tra trạng thái cấu hình thực tế.

## Kiểm thử cục bộ

```bash
node tests/verify.mjs
```
