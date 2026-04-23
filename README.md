# OCB Omni — "Chọn tất cả" giao dịch

Chrome extension thêm nút **"Chọn tất cả"** vào bảng *Sao kê tài khoản* trên
[OCB Omni KHDN](https://omnicorp.ocb.com.vn/) để tick hàng loạt giao dịch
chỉ với 1 click. Sau đó bấm **"TẢI VỀ CHI TIẾT"** của OCB để tải UNC /
Giấy báo Nợ / Giấy báo Có theo lô dưới dạng ZIP chứa PDF.

## Cài đặt (5 phút, 1 lần duy nhất)

### Bước 1 — Tải extension

Vào trang [Releases](https://github.com/phuc-nt/ocb-downloader/releases/latest)
→ tải file **`ocb-downloader.zip`** → **giải nén** ra thư mục (vd: `~/Downloads/ocb-downloader`).

> Không giải nén sẽ không cài được. Chrome cần thư mục, không phải file zip.

### Bước 2 — Load vào Chrome

1. Mở Chrome → gõ vào thanh địa chỉ: `chrome://extensions`
2. Bật **Developer mode** (công tắc góc trên bên phải)
3. Bấm **Load unpacked** → chọn thư mục vừa giải nén (`ocb-downloader`)
4. Xong — icon extension xuất hiện trên thanh Chrome

> Không cần update lại mỗi lần mở Chrome. Extension tự chạy khi vào OCB Omni.

## Cách dùng hàng tháng

1. Đăng nhập [OCB Omni](https://omnicorp.ocb.com.vn/)
2. Vào **Thông tin tài khoản → Sao kê tài khoản**
3. Chọn tài khoản + khoảng thời gian → bấm **Tìm kiếm**
4. Ở header bảng giao dịch có nút xanh **"Chọn tất cả (N)"** → bấm 1 lần
5. Bấm nút vàng **"TẢI VỀ CHI TIẾT"** (khung *Tóm tắt giao dịch*)
6. Chrome tự tải file `.zip` chứa tất cả UNC / Giấy báo Nợ / Giấy báo Có

### Nút nào là nút nào?

| Nút | Chức năng |
|---|---|
| **TẢI VỀ CHI TIẾT** (vàng, to) | Tải UNC/Giấy báo theo lô → ZIP chứa PDF — **dùng cái này** |
| **TẢI VỀ** (vàng, nhỏ, có mũi tên) | Export bảng sao kê ra XLS/PDF/XLSX tổng hợp |

## Cập nhật phiên bản mới

Khi có bản mới trên [Releases](https://github.com/phuc-nt/ocb-downloader/releases):

1. Tải ZIP mới → giải nén đè lên thư mục cũ (hoặc xóa thư mục cũ tạo mới)
2. Vào `chrome://extensions` → bấm nút **reload** (🔄) ở thẻ extension

## Giới hạn

- Chỉ tick các dòng **đang hiển thị trên trang hiện tại**. Nếu OCB phân trang,
  sang trang sau bấm lại "Chọn tất cả".
- Không tự động bấm "TẢI VỀ CHI TIẾT" — chủ ý, để user kiểm tra trước.
- Chỉ can thiệp bảng có cột "Mã giao dịch" để tránh đụng các bảng khác.

## Cách nó hoạt động (dành cho dev)

- `content/select-all-injector.js` quan sát DOM bằng MutationObserver. Khi
  thấy `.bd-table__header` có cột **"Mã giao dịch"**, nó chèn 1 `<button>`
  vào slot trống đầu header.
- Click → click tuần tự từng container `.bd-checkbox` (không phải `<input>`)
  để Angular directive `bd-change` kích hoạt và nút "TẢI VỀ CHI TIẾT" enable.
- Re-inject tự động sau mỗi lần bảng re-render (SPA).

## Cấu trúc

```
extension/
├── manifest.json
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── content/
    ├── select-all-injector.js
    └── select-all-injector.css
```

## License

MIT.
