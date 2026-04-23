/**
 * OCB Omni - Select All injector
 *
 * Page context: OCB Omni KHDN (omnicorp.ocb.com.vn), màn "Sao kê tài khoản".
 * Vấn đề: mỗi dòng giao dịch có 1 checkbox, nhưng header bảng KHÔNG có ô
 * "chọn tất cả" → user phải tick từng dòng trước khi bấm "TẢI VỀ".
 *
 * Giải pháp: quan sát DOM bằng MutationObserver, mỗi khi thấy bảng
 * `.bd-table__header` xuất hiện trong khu vực giao dịch thì chèn vào slot
 * trống `ng-show="$params.FIUser"` đầu header một nút checkbox tick-all.
 * Khi user click, ta click lần lượt từng `.bd-checkbox` container trong
 * các row `.bd-table__row-entry` để Angular directive `bd-change` kích
 * hoạt (click trực tiếp <input> sẽ bỏ qua logic Angular và nút "TẢI VỀ"
 * không enable).
 *
 * Scope hẹp: chỉ can thiệp bảng có header chứa cột "Mã giao dịch" để
 * tránh đụng chạm các bảng khác trên trang.
 */

(function () {
  'use strict';

  const MARKER_ATTR = 'data-ocb-select-all-injected';
  const BUTTON_CLASS = 'ocb-select-all-btn';

  /**
   * Tìm tất cả header bảng "Sao kê tài khoản" đang có trên trang.
   * Điều kiện: là `.bd-table__header` và chứa cell văn bản "Mã giao dịch".
   */
  function findStatementHeaders() {
    const headers = document.querySelectorAll('.bd-table__header');
    const matched = [];
    headers.forEach((h) => {
      const cells = h.querySelectorAll('.bd-table__heading');
      for (const c of cells) {
        if ((c.textContent || '').trim() === 'Mã giao dịch') {
          matched.push(h);
          break;
        }
      }
    });
    return matched;
  }

  /**
   * Trong bảng chứa `header`, lấy các row dữ liệu có checkbox.
   * `bd-table` render row-entry ở sibling tiếp theo của header (cùng cha).
   *
   * Lưu ý: OCB render row-entry lồng nhau (outer wrapper + inner content cùng
   * class), nên `querySelectorAll('.bd-table__row-entry')` sẽ trả về cả cha lẫn
   * con. Dedupe bằng cách chỉ giữ các row có parent KHÔNG phải row khác.
   */
  function findRowsForHeader(header) {
    const root = header.parentElement;
    if (!root) return [];
    const all = Array.from(root.querySelectorAll('.bd-table__row-entry'));
    const outerOnly = all.filter((r) => !r.parentElement?.closest('.bd-table__row-entry'));
    return outerOnly.filter((r) => r.querySelector('.bd-checkbox input[type=checkbox]'));
  }

  /**
   * Lấy trạng thái hiện tại của toàn bộ checkbox trong bảng.
   * Dùng để quyết định click nào sẽ select-all hay unselect-all.
   */
  function countCheckState(rows) {
    let total = 0;
    let checked = 0;
    rows.forEach((r) => {
      const cb = r.querySelector('.bd-checkbox input[type=checkbox]');
      if (!cb) return;
      // Bỏ qua disabled
      if (cb.disabled) return;
      total++;
      if (cb.checked) checked++;
    });
    return { total, checked };
  }

  /**
   * Toggle 1 checkbox theo cách Angular hiểu: click vào container .bd-checkbox.
   * OCB dùng custom directive `bd-change` gắn trên container; click <input>
   * thẳng sẽ không gọi handler và nút TẢI VỀ vẫn disabled.
   */
  function toggleCheckbox(container, desiredChecked) {
    const input = container.querySelector('input[type=checkbox]');
    if (!input || input.disabled) return false;
    if (input.checked === desiredChecked) return false;
    container.click();
    return true;
  }

  /**
   * Xử lý click nút "Chọn tất cả": nếu đã tick hết thì bỏ hết, ngược lại tick hết.
   * Thao tác tuần tự có throttle nhẹ để Angular kịp cập nhật scope.
   */
  async function onSelectAllClicked(header) {
    const rows = findRowsForHeader(header);
    if (!rows.length) return;

    const { total, checked } = countCheckState(rows);
    const desired = checked < total; // true nếu chưa tick đủ → select all

    for (const row of rows) {
      const container = row.querySelector('.bd-checkbox');
      if (!container) continue;
      toggleCheckbox(container, desired);
      // Yield cho Angular digest cycle; 0ms là đủ trên đa số máy,
      // nhưng vẫn dùng microtask để không chặn UI.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Cập nhật nhãn sau khi thao tác xong
    updateButtonLabel(header);
  }

  /**
   * Cập nhật nhãn nút theo trạng thái hiện tại.
   */
  function updateButtonLabel(header) {
    const btn = header.querySelector('.' + BUTTON_CLASS);
    if (!btn) return;
    const rows = findRowsForHeader(header);
    const { total, checked } = countCheckState(rows);

    if (total === 0) {
      btn.textContent = 'Chọn tất cả';
      btn.title = 'Không có dòng để chọn';
      btn.setAttribute('aria-disabled', 'true');
      return;
    }

    btn.removeAttribute('aria-disabled');
    if (checked === 0) {
      btn.textContent = `Chọn tất cả (${total})`;
      btn.title = `Tick toàn bộ ${total} giao dịch trong bảng`;
    } else if (checked === total) {
      btn.textContent = `Bỏ chọn (${checked})`;
      btn.title = 'Bỏ tick toàn bộ giao dịch';
    } else {
      btn.textContent = `Chọn tất cả (${checked}/${total})`;
      btn.title = `Đang tick ${checked}/${total}. Click để tick hết.`;
    }
  }

  /**
   * Chèn nút vào header nếu chưa có.
   */
  function injectIntoHeader(header) {
    if (header.getAttribute(MARKER_ATTR) === '1') return;

    // Slot trống dành cho FIUser là cell đầu tiên của header.
    // Nếu không tìm thấy, fallback chèn ngay đầu header.
    const slot = header.querySelector('[ng-show="$params.FIUser"]')
      || header.firstElementChild;
    if (!slot) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.textContent = 'Chọn tất cả';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelectAllClicked(header);
    });

    // Đảm bảo slot đủ rộng để hiện nút (OCB set width:50px)
    slot.style.width = 'auto';
    slot.style.minWidth = '120px';
    slot.style.textAlign = 'left';
    slot.appendChild(btn);

    header.setAttribute(MARKER_ATTR, '1');
    updateButtonLabel(header);
  }

  /**
   * Quét toàn bộ trang, chèn nút vào các header chưa có, cập nhật label.
   */
  function scanAndInject() {
    const headers = findStatementHeaders();
    headers.forEach((h) => {
      injectIntoHeader(h);
      updateButtonLabel(h);
    });
  }

  // Chạy lần đầu và theo dõi DOM thay đổi (Angular SPA re-render).
  scanAndInject();

  const observer = new MutationObserver(() => {
    // Debounce bằng requestAnimationFrame để tránh scan quá dày
    if (observer._scheduled) return;
    observer._scheduled = true;
    requestAnimationFrame(() => {
      observer._scheduled = false;
      scanAndInject();
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
