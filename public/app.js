/* ── DreamDB Client App ────────────────────────────── */
(function () {
  'use strict';

  // State
  let allRecords = [];
  let headers = [];
  let currentRecord = null; // null = new record
  let filterVisible = false;

  // DOM refs
  const viewLogin = document.getElementById('view-login');
  const viewApp = document.getElementById('view-app');
  const viewList = document.getElementById('view-list');
  const viewForm = document.getElementById('view-form');
  const recordsList = document.getElementById('records-list');
  const recordCount = document.getElementById('record-count');
  const searchInput = document.getElementById('search-input');
  const filterPanel = document.getElementById('filter-panel');
  const filterToggle = document.getElementById('btn-filter-toggle');
  const formIdBadge = document.getElementById('form-id-badge');
  const dreamForm = document.getElementById('dream-form');
  const formMsg = document.getElementById('form-msg');
  const btnBack = document.getElementById('btn-back');
  const btnNew = document.getElementById('btn-new');
  const btnLogout = document.getElementById('btn-logout');
  const btnSave = document.getElementById('btn-save');
  const btnCancel = document.getElementById('btn-cancel');
  const btnFilterReset = document.getElementById('btn-filter-reset');
  const imageSection = document.getElementById('image-section');
  const btnViewImages = document.getElementById('btn-view-images');
  const deleteSection = document.getElementById('delete-section');
  const btnDelete = document.getElementById('btn-delete');
  const imageModal = document.getElementById('image-modal');
  const imageModalBody = document.getElementById('image-modal-body');
  const imageModalClose = document.getElementById('image-modal-close');
  const imageModalBackdrop = document.getElementById('image-modal-backdrop');
  let pendingBlobUrls = [];
  let imageLoadAborted = false;

  // Field map: field name → element id
  const FIELD_IDS = {
    '夢主年代': 'f-age',
    '夢主性別': 'f-gender',
    '夢主の状況': 'f-situation',
    'ワーク前に自覚していた悩み': 'f-worry',
    'ワーク後に自覚した悩み': 'f-worry-after',
    '夢の分類': 'f-dream-type',
    '夢の内容': 'f-dream-content',
    'ワーク中の気づき': 'f-insight',
    '後日談': 'f-change',
    '大高メモ': 'f-memo',
    '教材化テーマ': 'f-theme',
    'テーマタグ': 'f-tags',
    '入力元': 'f-source',
    '公開可否': 'f-public',
  };

  // ── Init ──────────────────────────────────────────
  async function init() {
    const { user } = await api('/api/me');
    if (user) {
      showApp();
      await loadRecords();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    viewLogin.classList.remove('hidden');
    viewApp.classList.add('hidden');
  }

  function showApp() {
    viewLogin.classList.add('hidden');
    viewApp.classList.remove('hidden');
    showListView();
  }

  function showListView() {
    viewList.classList.remove('hidden');
    viewForm.classList.add('hidden');
    btnBack.classList.add('hidden');
    btnNew.classList.remove('hidden');
  }

  function showFormView(record) {
    currentRecord = record || null;
    viewList.classList.add('hidden');
    viewForm.classList.remove('hidden');
    btnBack.classList.remove('hidden');
    btnNew.classList.add('hidden');
    populateForm(record);
    formMsg.classList.add('hidden');
    formMsg.className = 'form-msg hidden';
  }

  // ── API ──────────────────────────────────────────
  async function api(url, method, body) {
    const opts = { method: method || 'GET', headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    return res.json();
  }

  // ── Records ──────────────────────────────────────
  async function loadRecords() {
    recordsList.innerHTML = '<div class="loading">読み込み中…</div>';
    try {
      const data = await api('/api/records');
      headers = data.headers || [];
      allRecords = data.records || [];
      renderList();
    } catch (e) {
      recordsList.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
    }
  }

  function renderList() {
    const keyword = searchInput.value.trim().toLowerCase();
    const filterAge = document.getElementById('filter-age').value;
    const filterGender = document.getElementById('filter-gender').value;
    const filterWorry = document.getElementById('filter-worry').value;
    const filterDreamType = document.getElementById('filter-dream-type').value;
    const filterPublic = document.getElementById('filter-public').value;

    let filtered = allRecords.filter(r => {
      if (filterAge && r['夢主年代'] !== filterAge) return false;
      if (filterGender && r['夢主性別'] !== filterGender) return false;
      if (filterWorry && r['ワーク前に自覚していた悩み'] !== filterWorry) return false;
      if (filterDreamType && r['夢の分類'] !== filterDreamType) return false;
      if (filterPublic && r['公開可否'] !== filterPublic) return false;
      if (keyword) {
        const searchable = [r['夢の内容'], r['ワーク中の気づき'], r['後日談'], r['大高メモ']].join(' ').toLowerCase();
        if (!searchable.includes(keyword)) return false;
      }
      return true;
    });

    // Sort: newest first (by 入力日時)
    filtered.sort((a, b) => (b['入力日時'] || '').localeCompare(a['入力日時'] || ''));

    recordCount.textContent = `${filtered.length} 件`;

    if (filtered.length === 0) {
      recordsList.innerHTML = '<div class="empty-state">該当するレコードがありません</div>';
      return;
    }

    recordsList.innerHTML = filtered.map(r => recordCard(r)).join('');
    recordsList.querySelectorAll('.record-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        const rec = allRecords.find(r => r['ID'] === id);
        if (rec) showFormView(rec);
      });
    });
  }

  function publicTagClass(val) {
    if (val === '公開可') return 'tag public-ok';
    if (val === '非公開') return 'tag public-no';
    return 'tag public-check';
  }

  function recordCard(r) {
    const preview = (r['夢の内容'] || '').slice(0, 80) + (r['夢の内容']?.length > 80 ? '…' : '');
    return `<div class="record-card" data-id="${esc(r['ID'])}">
      <div class="record-card-top">
        <span class="record-id">${esc(r['ID'])}</span>
        <span class="record-date">${esc(r['入力日時'] || '')}</span>
      </div>
      <div class="record-tags">
        ${r['夢主年代'] ? `<span class="tag">${esc(r['夢主年代'])}</span>` : ''}
        ${r['夢主性別'] ? `<span class="tag">${esc(r['夢主性別'])}</span>` : ''}
        ${r['ワーク前に自覚していた悩み'] ? `<span class="tag">${esc(r['ワーク前に自覚していた悩み'])}</span>` : ''}
        ${r['夢の分類'] ? `<span class="tag">${esc(r['夢の分類'])}</span>` : ''}
        ${r['公開可否'] ? `<span class="${publicTagClass(r['公開可否'])}">${esc(r['公開可否'])}</span>` : ''}
      </div>
      ${preview ? `<p class="record-preview">${esc(preview)}</p>` : ''}
    </div>`;
  }

  // ── Form ─────────────────────────────────────────
  function populateForm(record) {
    // Clear
    Object.values(FIELD_IDS).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    // Clear error states
    dreamForm.querySelectorAll('.error').forEach(el => el.classList.remove('error'));

    if (record) {
      formIdBadge.textContent = record['ID'];
      formIdBadge.classList.remove('hidden');
      Object.entries(FIELD_IDS).forEach(([field, elId]) => {
        const el = document.getElementById(elId);
        if (el && record[field] !== undefined) el.value = record[field];
      });
      btnSave.textContent = '変更を保存';
      const hasImages = (record['画像ID'] || '').trim().length > 0;
      imageSection.classList.toggle('hidden', !hasImages);
      deleteSection.classList.remove('hidden');
    } else {
      formIdBadge.classList.add('hidden');
      imageSection.classList.add('hidden');
      deleteSection.classList.add('hidden');
      // Set defaults
      document.getElementById('f-public').value = '要確認';
      document.getElementById('f-source').value = 'フォーム入力';
      btnSave.textContent = '保存する';
    }
    // Scroll to top of form
    viewForm.scrollTo ? viewForm.scrollTo(0, 0) : window.scrollTo(0, 0);
  }

  function collectFormData() {
    const data = {};
    Object.entries(FIELD_IDS).forEach(([field, elId]) => {
      const el = document.getElementById(elId);
      if (el) data[field] = el.value.trim();
    });
    return data;
  }

  function validateForm(data) {
    const required = ['夢主年代', '夢主性別', '夢主の状況', '夢の分類', '夢の内容', 'ワーク中の気づき', '入力元', '公開可否'];
    let valid = true;
    dreamForm.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
    required.forEach(field => {
      if (!data[field]) {
        const el = document.getElementById(FIELD_IDS[field]);
        if (el) el.classList.add('error');
        valid = false;
      }
    });
    return valid;
  }

  function showMsg(type, text) {
    formMsg.className = `form-msg ${type}`;
    formMsg.textContent = text;
    formMsg.classList.remove('hidden');
    formMsg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── Event Listeners ──────────────────────────────
  document.getElementById('btn-google-login').addEventListener('click', () => {
    window.location.href = '/auth/google';
  });

  btnLogout.addEventListener('click', async () => {
    await api('/api/logout', 'POST');
    showLogin();
  });

  btnNew.addEventListener('click', () => showFormView(null));
  btnBack.addEventListener('click', () => {
    showListView();
    loadRecords();
  });
  btnCancel.addEventListener('click', () => {
    showListView();
    loadRecords();
  });

  filterToggle.addEventListener('click', () => {
    filterVisible = !filterVisible;
    filterPanel.classList.toggle('hidden', !filterVisible);
    filterToggle.classList.toggle('active', filterVisible);
  });

  btnFilterReset.addEventListener('click', () => {
    ['filter-age','filter-gender','filter-worry','filter-dream-type','filter-public'].forEach(id => {
      document.getElementById(id).value = '';
    });
    renderList();
  });

  searchInput.addEventListener('input', () => renderList());
  ['filter-age','filter-gender','filter-worry','filter-dream-type','filter-public'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => renderList());
  });

  dreamForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = collectFormData();
    if (!validateForm(data)) {
      showMsg('error', '必須項目を入力してください（赤枠の項目）');
      return;
    }

    btnSave.disabled = true;
    btnSave.textContent = '保存中…';

    try {
      let result;
      if (currentRecord) {
        result = await api(`/api/records/${currentRecord['ID']}`, 'PUT', data);
      } else {
        result = await api('/api/records', 'POST', data);
      }

      if (result.error) throw new Error(result.error);

      showMsg('success', currentRecord ? '変更を保存しました' : `保存しました (${result.id})`);
      await loadRecords();
      setTimeout(() => {
        showListView();
        loadRecords();
      }, 1500);
    } catch (err) {
      showMsg('error', err.message || '保存に失敗しました');
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = currentRecord ? '変更を保存' : '保存する';
    }
  });

  // ── Utility ──────────────────────────────────────
  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Image Viewer ─────────────────────────────────
  function closeImageModal() {
    imageModal.classList.add('hidden');
    imageLoadAborted = true;
    pendingBlobUrls.forEach(url => URL.revokeObjectURL(url));
    pendingBlobUrls = [];
    imageModalBody.innerHTML = '';
  }

  btnViewImages.addEventListener('click', async () => {
    if (!currentRecord) return;
    const ids = (currentRecord['画像ID'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return;

    pendingBlobUrls.forEach(url => URL.revokeObjectURL(url));
    pendingBlobUrls = [];
    imageLoadAborted = false;

    imageModalBody.innerHTML = '<div class="loading" style="color:#ccc;padding:16px;">読み込み中…</div>';
    imageModal.classList.remove('hidden');

    try {
      const urls = await Promise.all(ids.map(async id => {
        const res = await fetch(`/api/images/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`画像取得失敗 (${id})`);
        return URL.createObjectURL(await res.blob());
      }));
      if (imageLoadAborted) {
        urls.forEach(url => URL.revokeObjectURL(url));
        return;
      }
      pendingBlobUrls = urls;
      imageModalBody.innerHTML = urls.map(url =>
        `<img src="${url}" style="max-width:80vw;max-height:75vh;object-fit:contain;border-radius:6px;display:block;">`
      ).join('');
    } catch (e) {
      if (!imageLoadAborted) {
        imageModalBody.innerHTML = `<p style="color:#f88;padding:16px;">${esc(e.message)}</p>`;
      }
    }
  });

  imageModalClose.addEventListener('click', closeImageModal);
  imageModalBackdrop.addEventListener('click', closeImageModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeImageModal();
  });

  btnDelete.addEventListener('click', async () => {
    const id = formIdBadge.textContent;
    if (!id) return;
    if (!confirm(`レコード「${id}」を削除します。この操作は取り消せません。よろしいですか？`)) return;
    try {
      const res = await api(`/api/records/${encodeURIComponent(id)}`, 'DELETE');
      if (res.ok) {
        await loadRecords();
        showListView();
      } else {
        alert('削除に失敗しました: ' + (res.error || '不明なエラー'));
      }
    } catch (e) {
      alert('削除に失敗しました: ' + e.message);
    }
  });

  // ── Start ────────────────────────────────────────
  init();
})();
