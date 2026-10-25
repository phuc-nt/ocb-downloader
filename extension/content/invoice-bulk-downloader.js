/**
 * OCB Omni - Invoice bulk downloader
 *
 * Page context: OCB Omni KHDN, màn "Hóa đơn điện tử" (#/accounts//invoices).
 * Vấn đề: mỗi hóa đơn có link XML | PDF riêng, phân trang 10 dòng/trang →
 * vài trăm hóa đơn/tháng phải bấm tay từng cái.
 *
 * Giải pháp: dùng lại đúng 2 API mà trang OCB đang gọi, bằng session sẵn có:
 *  - Danh sách: GET /frontend-web/api/invobil_payment_notices?customerId&dateFrom&dateTo&pageNumber&pageSize
 *    (server trả toàn bộ hóa đơn trong khoảng ngày trong 1 response, phân trang
 *    10 dòng chỉ là phía UI).
 *  - File: GET /frontend-web/api/account/downloads/account_electronic_invoice_download?billId&billType=XML|PDF
 *
 * Tham số danh sách (customerId, khoảng ngày) lấy từ request gần nhất mà trang
 * vừa gọi (Resource Timing), nên luôn khớp với bộ lọc user đang chọn.
 * Kết quả gom vào 1 file ZIP (định dạng STORE, không nén) kèm danh-sach.csv.
 */

(function () {
  'use strict';

  const API_BASE = '/frontend-web/api';
  const LIST_PATH = API_BASE + '/invobil_payment_notices';
  const DOWNLOAD_PATH = API_BASE + '/account/downloads/account_electronic_invoice_download';
  const TOOLBAR_ID = 'ocb-invoice-bulk-toolbar';
  const CONCURRENCY = 4;
  const MAX_RETRIES = 2;

  let lastListUrl = null;
  let running = null; // { cancelled: boolean } khi đang tải

  /**
   * Theo dõi request danh sách hóa đơn mà trang gọi mỗi khi đổi bộ lọc.
   * `buffered: true` để bắt cả request đã xảy ra trước khi script chạy.
   */
  function watchListRequests() {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => {
        if (e.name.indexOf(LIST_PATH + '?') !== -1) lastListUrl = e.name;
      });
    });
    observer.observe({ type: 'resource', buffered: true });
  }

  function isInvoicesPage() {
    return /\/invoices(\b|$)/.test(location.hash);
  }

  function getXsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function apiGet(url) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'X-XSRF-TOKEN': getXsrfToken() },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // Hết phiên → server trả trang HTML đăng nhập thay vì dữ liệu
    if ((res.headers.get('content-type') || '').indexOf('text/html') !== -1) {
      throw new Error('Phiên đăng nhập đã hết hạn, hãy đăng nhập lại');
    }
    return res;
  }

  /**
   * Lấy toàn bộ hóa đơn theo bộ lọc hiện tại của trang.
   */
  async function fetchInvoiceList() {
    if (!lastListUrl) {
      throw new Error('Chưa thấy danh sách hóa đơn, hãy chọn khoảng ngày trước');
    }
    const url = new URL(lastListUrl);
    url.searchParams.set('pageNumber', '1');
    url.searchParams.set('pageSize', '100000');
    const res = await apiGet(url.pathname + url.search);
    const data = await res.json();
    return {
      items: data.content || [],
      dateFrom: url.searchParams.get('dateFrom') || '',
      dateTo: url.searchParams.get('dateTo') || '',
    };
  }

  function parseFilename(contentDisposition) {
    if (!contentDisposition) return null;
    const star = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) return decodeURIComponent(star[1].trim());
    const plain = contentDisposition.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1].trim() : null;
  }

  function formatDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  async function downloadInvoiceFile(item, type) {
    const url = DOWNLOAD_PATH + '?billId=' + encodeURIComponent(item.billId)
      + '&billType=' + type;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await apiGet(url);
        const name = parseFilename(res.headers.get('content-disposition'))
          || item.billId + '.' + type.toLowerCase();
        const data = new Uint8Array(await res.arrayBuffer());
        return { name, data };
      } catch (err) {
        lastErr = err;
        if (/hết hạn/.test(err.message)) break;
      }
    }
    throw lastErr;
  }

  /**
   * Tạo danh sách job (hóa đơn × loại file), bỏ qua file OCB đánh dấu không tải được.
   */
  function buildJobs(items, types) {
    const jobs = [];
    items.forEach((item) => {
      types.forEach((type) => {
        const flag = type === 'XML' ? item.isDownloadXMLFile : item.isDownloadPDFFile;
        if (flag === '1') jobs.push({ item, type });
      });
    });
    return jobs;
  }

  async function runPool(jobs, worker, onProgress, state) {
    let next = 0;
    let done = 0;
    async function lane() {
      while (next < jobs.length && !state.cancelled) {
        const job = jobs[next++];
        await worker(job);
        done++;
        onProgress(done, jobs.length);
      }
    }
    const lanes = [];
    for (let i = 0; i < Math.min(CONCURRENCY, jobs.length); i++) lanes.push(lane());
    await Promise.all(lanes);
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async function onDownloadClicked(types) {
    if (running) return;
    const state = { cancelled: false };
    running = state;
    setBusy(true);

    try {
      setStatus('Đang lấy danh sách hóa đơn…');
      const { items, dateFrom, dateTo } = await fetchInvoiceList();
      const jobs = buildJobs(items, types);
      if (!jobs.length) {
        setStatus('Không có hóa đơn nào để tải trong khoảng ngày này.');
        return;
      }

      const zip = new ZipWriter();
      const usedNames = new Set();
      const errors = [];
      const fileOf = new Map(); // billId → { XML: name, PDF: name }

      await runPool(jobs, async ({ item, type }) => {
        try {
          const { name, data } = await downloadInvoiceFile(item, type);
          let path = (types.length > 1 ? type + '/' : '') + formatDate(item.date) + '_' + name;
          for (let i = 2; usedNames.has(path); i++) {
            path = path.replace(/(\.\w+)$/, '_' + i + '$1');
          }
          usedNames.add(path);
          zip.add(path, data);
          const entry = fileOf.get(item.billId) || {};
          entry[type] = path;
          fileOf.set(item.billId, entry);
        } catch (err) {
          errors.push({ item, type, message: err.message });
          if (/hết hạn/.test(err.message)) state.cancelled = true;
        }
      }, (done, total) => {
        setStatus('Đang tải ' + done + '/' + total + ' file'
          + (errors.length ? ' (' + errors.length + ' lỗi)' : '') + '…');
      }, state);

      if (state.cancelled && !errors.some((e) => /hết hạn/.test(e.message))) {
        setStatus('Đã hủy.');
        return;
      }

      const header = ['Ngày giao dịch', 'Diễn giải', 'Tổng tiền', 'Mã hóa đơn']
        .concat(types.map((t) => 'File ' + t), ['Lỗi']);
      const rows = items.map((item) => {
        const files = fileOf.get(item.billId) || {};
        const errs = errors.filter((e) => e.item === item)
          .map((e) => e.type + ': ' + e.message).join('; ');
        return [formatDate(item.date), item.title, item.amount, item.billId]
          .concat(types.map((t) => files[t] || ''), [errs]);
      });
      const csv = '﻿' + [header].concat(rows)
        .map((r) => r.map(csvCell).join(',')).join('\r\n');
      zip.add('danh-sach.csv', new TextEncoder().encode(csv));

      const zipName = 'hoa-don-OCB_' + dateFrom + '_' + dateTo + '_' + types.join('-') + '.zip';
      saveBlob(zip.toBlob(), zipName);

      const ok = jobs.length - errors.length;
      setStatus('Xong: ' + ok + '/' + jobs.length + ' file → ' + zipName
        + (errors.length ? '. ' + errors.length + ' lỗi, xem cột "Lỗi" trong danh-sach.csv' : ''));
    } catch (err) {
      setStatus('Lỗi: ' + err.message);
    } finally {
      running = null;
      setBusy(false);
    }
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /**
   * Ghi file ZIP tối giản (STORE, không nén) — đủ cho XML/PDF, không cần thư viện.
   * Không hỗ trợ ZIP64: giới hạn 4GB / 65535 file, thừa cho vài nghìn hóa đơn.
   */
  class ZipWriter {
    constructor() {
      this.parts = [];
      this.central = [];
      this.offset = 0;
      const now = new Date();
      this.dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      this.dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    }

    add(path, data) {
      const name = new TextEncoder().encode(path);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // bit 11: tên file UTF-8
      local.setUint16(8, 0, true); // STORE
      local.setUint16(10, this.dosTime, true);
      local.setUint16(12, this.dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, this.dosTime, true);
      cen.setUint16(14, this.dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, this.offset, true);

      this.parts.push(new Uint8Array(local.buffer), name, data);
      this.central.push(new Uint8Array(cen.buffer), name);
      this.offset += 30 + name.length + data.length;
    }

    toBlob() {
      const count = this.central.length / 2;
      const size = this.central.reduce((s, p) => s + p.length, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, count, true);
      end.setUint16(10, count, true);
      end.setUint32(12, size, true);
      end.setUint32(16, this.offset, true);
      return new Blob(this.parts.concat(this.central, [new Uint8Array(end.buffer)]),
        { type: 'application/zip' });
    }
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- UI ----------

  function setStatus(text) {
    const el = document.querySelector('#' + TOOLBAR_ID + ' .ocb-invoice-bulk-status');
    if (el) el.textContent = text;
  }

  function setBusy(busy) {
    const bar = document.getElementById(TOOLBAR_ID);
    if (!bar) return;
    bar.querySelectorAll('.ocb-invoice-bulk-btn').forEach((b) => { b.disabled = busy; });
    const cancel = bar.querySelector('.ocb-invoice-bulk-cancel');
    if (cancel) cancel.hidden = !busy;
  }

  function makeButton(label, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /**
   * Chèn toolbar ngay trên bảng hóa đơn nếu chưa có.
   */
  function injectToolbar() {
    if (!isInvoicesPage() || document.getElementById(TOOLBAR_ID)) return;
    const table = document.querySelector('bd-table.table-E1, .table-E1');
    if (!table || !table.parentElement) return;

    const bar = document.createElement('div');
    bar.id = TOOLBAR_ID;
    bar.appendChild(makeButton('Tải tất cả XML', 'ocb-invoice-bulk-btn', () => onDownloadClicked(['XML'])));
    bar.appendChild(makeButton('Tải tất cả PDF', 'ocb-invoice-bulk-btn', () => onDownloadClicked(['PDF'])));
    bar.appendChild(makeButton('Tải XML + PDF', 'ocb-invoice-bulk-btn', () => onDownloadClicked(['XML', 'PDF'])));
    const cancel = makeButton('Hủy', 'ocb-invoice-bulk-cancel', () => {
      if (running) running.cancelled = true;
    });
    cancel.hidden = true;
    bar.appendChild(cancel);
    const status = document.createElement('span');
    status.className = 'ocb-invoice-bulk-status';
    status.textContent = 'Tải toàn bộ hóa đơn trong khoảng ngày đang chọn thành 1 file ZIP';
    bar.appendChild(status);

    table.parentElement.insertBefore(bar, table);
    if (running) setBusy(true);
  }

  watchListRequests();
  injectToolbar();

  const observer = new MutationObserver(() => {
    if (observer._scheduled) return;
    observer._scheduled = true;
    requestAnimationFrame(() => {
      observer._scheduled = false;
      injectToolbar();
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
