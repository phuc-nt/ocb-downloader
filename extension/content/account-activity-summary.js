/**
 * OCB Omni - Account activity summary
 *
 * Page context: OCB Omni KHDN, màn "Sao kê tài khoản" (#/accounts//transactions).
 * Vấn đề: muốn biết hôm nay tài khoản nào có phát sinh phải chọn từng tài khoản
 * trong dropdown rồi bấm Tìm kiếm, lặp lại cho cả chục tài khoản.
 *
 * Giải pháp: 1 nút quét toàn bộ tài khoản theo khoảng ngày đang chọn, cộng
 * phát sinh tăng (ghi có) / giảm (ghi nợ) theo từng ngày × tài khoản, dùng lại
 * đúng API mà trang OCB đang gọi:
 *  - Danh sách tài khoản: GET /frontend-web/api/account_cb
 *  - Lịch sử giao dịch: GET /frontend-web/api/transaction/get/search_historys.json
 *    ?accountId&currentBalance&dateFrom&dateTo&filterDateByTransDate&...&pageNumber&pageSize
 *
 * Khoảng ngày và "Tìm theo" (Ngày tạo / Ngày thực hiện) lấy từ request sao kê
 * gần nhất mà trang vừa gọi, nên luôn khớp với bộ lọc user đang chọn.
 * Tên tài khoản trên OCB giống hệt nhau, nên cho phép tự đặt tên (lưu localStorage).
 */

(function () {
  'use strict';

  const API_BASE = '/frontend-web/api';
  const ACCOUNTS_PATH = API_BASE + '/account_cb';
  const HISTORY_PATH = API_BASE + '/transaction/get/search_historys.json';
  const TOOLBAR_ID = 'ocb-activity-toolbar';
  const PANEL_ID = 'ocb-activity-panel';
  const NAMES_KEY = 'ocb-ext-account-names';
  const PAGE_SIZE = 1000;
  const CONCURRENCY = 4;
  const MAX_RETRIES = 2;

  let lastHistoryUrl = null;
  let running = null; // { cancelled: boolean } khi đang quét
  let lastResult = null;
  let showInactive = false;

  /**
   * Theo dõi request sao kê mà trang gọi mỗi khi bấm Tìm kiếm.
   * `buffered: true` để bắt cả request đã xảy ra trước khi script chạy.
   */
  function watchHistoryRequests() {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => {
        if (e.name.indexOf(HISTORY_PATH + '?') !== -1) lastHistoryUrl = e.name;
      });
      if (!running) setStatus(describeFilter());
    });
    observer.observe({ type: 'resource', buffered: true });
  }

  function getCurrentFilter() {
    if (!lastHistoryUrl) return null;
    const params = new URL(lastHistoryUrl).searchParams;
    return {
      dateFrom: params.get('dateFrom') || '',
      dateTo: params.get('dateTo') || '',
      byTransDate: params.get('filterDateByTransDate') === 'true',
    };
  }

  function viDate(iso) {
    return iso.split('-').reverse().join('.');
  }

  function describeFilter() {
    const f = getCurrentFilter();
    if (!f) return 'Chọn khoảng ngày rồi bấm Tìm kiếm để bắt đầu';
    return 'Theo bộ lọc: ' + viDate(f.dateFrom) + ' – ' + viDate(f.dateTo)
      + ' (' + (f.byTransDate ? 'Ngày tạo' : 'Ngày thực hiện') + ')';
  }

  function isTransactionsPage() {
    return /\/transactions(\b|$)/.test(location.hash);
  }

  function getXsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function apiGetJson(url) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          credentials: 'same-origin',
          headers: { 'X-XSRF-TOKEN': getXsrfToken() },
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // Hết phiên → server trả trang HTML đăng nhập thay vì dữ liệu
        if ((res.headers.get('content-type') || '').indexOf('text/html') !== -1) {
          throw new Error('Phiên đăng nhập đã hết hạn, hãy đăng nhập lại');
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (/hết hạn/.test(err.message)) break;
      }
    }
    throw lastErr;
  }

  function formatDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function formatAccountNo(no) {
    return String(no).replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  function formatMoney(n) {
    return n ? Math.round(n).toLocaleString('en-US') : '-';
  }

  function loadNames() {
    try {
      return JSON.parse(localStorage.getItem(NAMES_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveName(accountNo, name) {
    const names = loadNames();
    if (name) names[accountNo] = name;
    else delete names[accountNo];
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(names));
    } catch (e) { /* bộ nhớ bị chặn: tên chỉ giữ trong phiên này */ }
  }

  /**
   * Lấy toàn bộ giao dịch của 1 tài khoản trong khoảng ngày, cộng theo ngày.
   * Trả về Map ngày → { credit, debit, count }.
   */
  async function fetchAccountDays(account, filter) {
    const days = new Map();
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({
        accountId: account.accountId,
        currentBalance: account.currentBalance,
        dateFrom: filter.dateFrom,
        dateTo: filter.dateTo,
        filterDateByTransDate: String(filter.byTransDate),
        operationAmountFrom: '0',
        operationAmountTo: '3000000000000',
        pageNumber: String(page),
        pageSize: String(PAGE_SIZE),
        sortType: 'latest',
      });
      const data = await apiGetJson(HISTORY_PATH + '?' + params);
      const list = (data && data.list) || {};
      (list.content || []).forEach((t) => {
        const day = formatDate(filter.byTransDate ? t.transactionDateTime : t.bookingDate);
        const sum = days.get(day) || { credit: 0, debit: 0, count: 0 };
        sum.credit += t.credit || 0;
        sum.debit += Math.abs(t.debit || 0);
        sum.count++;
        days.set(day, sum);
      });
      if (list.lastPage !== false || page >= (list.totalPages || 1)) break;
    }
    return days;
  }

  async function onSummaryClicked() {
    if (running) return;
    const filter = getCurrentFilter();
    if (!filter) {
      setStatus('Chưa thấy sao kê, hãy chọn khoảng ngày rồi bấm Tìm kiếm trước');
      return;
    }
    const state = { cancelled: false };
    running = state;
    setBusy(true);

    try {
      setStatus('Đang lấy danh sách tài khoản…');
      const accData = await apiGetJson(ACCOUNTS_PATH);
      const accounts = ((accData && accData.data) || []).filter((a) => a.productType === 'ACCOUNT');
      if (!accounts.length) throw new Error('Không thấy tài khoản nào');

      const errors = [];
      let next = 0;
      let done = 0;
      async function lane() {
        while (next < accounts.length && !state.cancelled) {
          const acc = accounts[next++];
          try {
            acc.days = await fetchAccountDays(acc, filter);
          } catch (err) {
            acc.error = err.message;
            errors.push(acc);
            if (/hết hạn/.test(err.message)) state.cancelled = true;
          }
          done++;
          setStatus('Đang quét ' + done + '/' + accounts.length + ' tài khoản…');
        }
      }
      const lanes = [];
      for (let i = 0; i < Math.min(CONCURRENCY, accounts.length); i++) lanes.push(lane());
      await Promise.all(lanes);

      if (state.cancelled && !errors.some((a) => /hết hạn/.test(a.error))) {
        setStatus('Đã hủy.');
        return;
      }

      lastResult = { filter, accounts };
      renderPanel();
      const active = accounts.filter((a) => a.days && a.days.size).length;
      setStatus('Xong: ' + active + '/' + accounts.length + ' tài khoản có phát sinh'
        + (errors.length ? '. ' + errors.length + ' tài khoản lỗi: '
          + errors.map((a) => a.accountNo + ' (' + a.error + ')').join(', ') : ''));
    } catch (err) {
      setStatus('Lỗi: ' + err.message);
    } finally {
      running = null;
      setBusy(false);
    }
  }

  /**
   * Gom kết quả thành các khối: mỗi ngày có phát sinh 1 khối, thêm khối
   * "Cả khoảng" ở đầu khi khoảng ngày dài hơn 1 ngày.
   */
  function buildBlocks(result) {
    const { filter, accounts } = result;
    const allDays = new Set();
    accounts.forEach((a) => a.days && a.days.forEach((_, d) => allDays.add(d)));
    const sortedDays = Array.from(allDays).sort();

    const rowsFor = (pick) => accounts.map((a) => {
      const sum = a.days ? pick(a.days) : null;
      return { account: a, credit: sum ? sum.credit : 0, debit: sum ? sum.debit : 0,
        count: sum ? sum.count : 0 };
    });

    const blocks = sortedDays.map((day) => ({
      title: 'Ngày ' + viDate(day),
      day,
      rows: rowsFor((days) => days.get(day)),
    }));

    if (filter.dateFrom !== filter.dateTo) {
      blocks.unshift({
        title: 'Cả khoảng ' + viDate(filter.dateFrom) + ' – ' + viDate(filter.dateTo),
        day: filter.dateFrom + '_' + filter.dateTo,
        rows: rowsFor((days) => {
          const total = { credit: 0, debit: 0, count: 0 };
          days.forEach((s) => { total.credit += s.credit; total.debit += s.debit; total.count += s.count; });
          return total;
        }),
      });
    }
    return blocks;
  }

  function displayName(account, names) {
    return names[account.accountNo] || account.accountName || '';
  }

  /**
   * Dạng tab-separated để dán thẳng vào Excel.
   */
  function blockToTsv(block) {
    const names = loadNames();
    const header = ['Số tài khoản', 'Tên tài khoản', 'Phát sinh tăng', 'Phát sinh giảm', 'Số GD'];
    const lines = [header.join('\t')];
    block.rows.forEach((r) => {
      if (!showInactive && !r.count) return;
      lines.push([formatAccountNo(r.account.accountNo), displayName(r.account, names),
        r.credit || '', r.debit || '', r.count || ''].join('\t'));
    });
    return lines.join('\n');
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv() {
    if (!lastResult) return;
    const names = loadNames();
    const { filter, accounts } = lastResult;
    const header = ['Ngày', 'Số tài khoản', 'Tên tài khoản', 'Phát sinh tăng', 'Phát sinh giảm', 'Số GD', 'Lỗi'];
    const rows = [];
    buildBlocks(lastResult).filter((b) => b.title.indexOf('Ngày') === 0).forEach((b) => {
      b.rows.forEach((r) => {
        if (!showInactive && !r.count) return;
        rows.push([viDate(b.day), "'" + formatAccountNo(r.account.accountNo),
          displayName(r.account, names), r.credit, r.debit, r.count, '']);
      });
    });
    accounts.filter((a) => a.error).forEach((a) => {
      rows.push(['', "'" + formatAccountNo(a.accountNo), displayName(a, names), '', '', '', a.error]);
    });
    const csv = '﻿' + [header].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'phat-sinh-OCB_' + filter.dateFrom + '_' + filter.dateTo + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- UI ----------

  function setStatus(text) {
    const el = document.querySelector('#' + TOOLBAR_ID + ' .ocb-activity-status');
    if (el) el.textContent = text;
  }

  function setBusy(busy) {
    const bar = document.getElementById(TOOLBAR_ID);
    if (!bar) return;
    bar.querySelectorAll('.ocb-activity-btn').forEach((b) => { b.disabled = busy; });
    const cancel = bar.querySelector('.ocb-activity-cancel');
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
      onClick(btn);
    });
    return btn;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderBlock(block, names) {
    const wrap = el('div', 'ocb-activity-block');
    const head = el('div', 'ocb-activity-block-head');
    head.appendChild(el('h4', null, block.title));
    head.appendChild(makeButton('Sao chép', 'ocb-activity-copy', (btn) => {
      navigator.clipboard.writeText(blockToTsv(block)).then(() => {
        btn.textContent = 'Đã chép ✓';
        setTimeout(() => { btn.textContent = 'Sao chép'; }, 1500);
      });
    }));
    wrap.appendChild(head);

    const table = el('table', 'ocb-activity-table');
    const thead = el('tr');
    ['Số tài khoản', 'Tên tài khoản', 'Phát sinh tăng', 'Phát sinh giảm', 'Số GD']
      .forEach((h) => thead.appendChild(el('th', null, h)));
    table.appendChild(thead);

    const total = { credit: 0, debit: 0, count: 0 };
    block.rows.forEach((r) => {
      if (!showInactive && !r.count && !r.account.error) return;
      const tr = el('tr', r.count ? 'is-active' : '');
      tr.appendChild(el('td', 'ocb-activity-no', formatAccountNo(r.account.accountNo)));

      const nameTd = el('td');
      const input = el('input', 'ocb-activity-name');
      input.value = names[r.account.accountNo] || '';
      input.placeholder = r.account.accountName || 'Đặt tên…';
      input.title = 'Tự đặt tên cho tài khoản, extension sẽ nhớ cho lần sau';
      input.addEventListener('change', () => {
        saveName(r.account.accountNo, input.value.trim());
        renderPanel();
      });
      nameTd.appendChild(input);
      tr.appendChild(nameTd);

      if (r.account.error) {
        const err = el('td', 'ocb-activity-error', 'Lỗi: ' + r.account.error);
        err.colSpan = 3;
        tr.appendChild(err);
      } else {
        tr.appendChild(el('td', 'ocb-activity-num', formatMoney(r.credit)));
        tr.appendChild(el('td', 'ocb-activity-num is-debit',
          r.debit ? '(' + formatMoney(r.debit) + ')' : '-'));
        tr.appendChild(el('td', 'ocb-activity-num', r.count ? String(r.count) : '-'));
      }
      table.appendChild(tr);
      total.credit += r.credit;
      total.debit += r.debit;
      total.count += r.count;
    });

    const foot = el('tr', 'ocb-activity-total');
    foot.appendChild(el('td', null, 'Tổng'));
    foot.appendChild(el('td'));
    foot.appendChild(el('td', 'ocb-activity-num', formatMoney(total.credit)));
    foot.appendChild(el('td', 'ocb-activity-num is-debit',
      total.debit ? '(' + formatMoney(total.debit) + ')' : '-'));
    foot.appendChild(el('td', 'ocb-activity-num', String(total.count)));
    table.appendChild(foot);

    wrap.appendChild(table);
    return wrap;
  }

  function renderPanel() {
    const bar = document.getElementById(TOOLBAR_ID);
    if (!bar || !lastResult) return;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = el('div');
      panel.id = PANEL_ID;
      bar.insertAdjacentElement('afterend', panel);
    }
    panel.textContent = '';

    const tools = el('div', 'ocb-activity-tools');
    const label = el('label');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = showInactive;
    check.addEventListener('change', () => {
      showInactive = check.checked;
      renderPanel();
    });
    label.appendChild(check);
    label.appendChild(document.createTextNode(' Hiện cả tài khoản không phát sinh'));
    tools.appendChild(label);
    tools.appendChild(makeButton('Tải Excel (CSV)', 'ocb-activity-copy', downloadCsv));
    tools.appendChild(makeButton('Đóng', 'ocb-activity-copy', () => {
      lastResult = null;
      panel.remove();
    }));
    panel.appendChild(tools);

    const names = loadNames();
    const blocks = buildBlocks(lastResult);
    if (!blocks.some((b) => b.rows.some((r) => r.count))) {
      panel.appendChild(el('p', 'ocb-activity-empty', 'Không tài khoản nào có phát sinh trong khoảng ngày này.'));
    }
    blocks.forEach((b) => panel.appendChild(renderBlock(b, names)));
  }

  /**
   * Chèn toolbar ngay dưới khối "Xuất chứng từ" nếu chưa có.
   */
  function injectToolbar() {
    if (!isTransactionsPage() || document.getElementById(TOOLBAR_ID)) return;
    const anchor = document.querySelector('.export-statement');
    if (!anchor || !anchor.parentElement) return;

    const bar = el('div');
    bar.id = TOOLBAR_ID;
    bar.appendChild(makeButton('Tổng hợp phát sinh tất cả tài khoản', 'ocb-activity-btn', onSummaryClicked));
    const cancel = makeButton('Hủy', 'ocb-activity-cancel', () => {
      if (running) running.cancelled = true;
    });
    cancel.hidden = true;
    bar.appendChild(cancel);
    bar.appendChild(el('span', 'ocb-activity-status', describeFilter()));

    anchor.insertAdjacentElement('afterend', bar);
    if (running) setBusy(true);
    renderPanel();
  }

  watchHistoryRequests();
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
