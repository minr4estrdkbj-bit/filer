/**
 * Filer - Single Column Keyboard-driven File Manager Client
 */

let currentPath = '';
let parentPath = '';
let allItems = [];
let filteredItems = [];
let selectedIndex = 0;

let showHidden = localStorage.getItem('filer_show_hidden') === 'true';
let sortKey = localStorage.getItem('filer_sort_key') || 'name';
let sortAsc = localStorage.getItem('filer_sort_asc') !== 'false';
let currentTheme = localStorage.getItem('filer_theme') || 'theme-dark';

let clipboard = {
  action: null, // 'copy' | 'cut'
  path: '',
  name: '',
  isDir: false
};
let isModalOpen = false;
let modalCallback = null;
let isHelpOpen = false;

// --- 初期化 ---
async function init() {
  applyTheme(currentTheme);
  updateHiddenToggleUI();
  updateSortHeadersUI();

  // イベント登録
  setupEvents();

  // 初期パス決定 (URLの ?cwd= パラメータまたはルート/ホーム)
  const urlParams = new URLSearchParams(window.location.search);
  const initialPath = urlParams.get('cwd') || '';

  await loadDirectory(initialPath);

  // 定期ハートビート
  setInterval(() => {
    fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
  }, 2000);

  window.addEventListener('pagehide', () => {
    navigator.sendBeacon('/api/close');
  });
}

// --- ディレクトリ読み込み ---
async function loadDirectory(targetPath, previousChildPath = '') {
  showLoading(true);
  try {
    let url = '/api/ls';
    const params = new URLSearchParams();
    if (targetPath) params.set('cwd', targetPath);
    if (showHidden) params.set('showHidden', 'true');
    const queryString = params.toString();
    if (queryString) url += '?' + queryString;

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }

    const data = await res.json();
    currentPath = data.current;
    parentPath = data.parent;
    allItems = data.items || [];

    // URL更新
    const nextUrlParams = new URLSearchParams(window.location.search);
    nextUrlParams.set('cwd', currentPath);
    window.history.replaceState({}, '', `${window.location.pathname}?${nextUrlParams.toString()}`);
    document.title = `Filer - ${basename(currentPath) || '/'}`;

    renderBreadcrumbs();
    applyFilterAndSort();

    // 直前にいた子ディレクトリがあればそれを選択
    if (previousChildPath) {
      const idx = filteredItems.findIndex(item => item.path === previousChildPath);
      if (idx >= 0) {
        selectedIndex = idx;
      }
    } else {
      selectedIndex = 0;
    }

    renderTable();
  } catch (err) {
    alert('フォルダの読み込みに失敗しました: ' + err.message);
  } finally {
    showLoading(false);
  }
}

// --- フィルタ & ソート ---
function applyFilterAndSort() {
  const filterInput = document.getElementById('filter-input');
  const query = (filterInput ? filterInput.value : '').trim().toLowerCase();

  // フィルタリング
  filteredItems = allItems.filter(item => {
    if (!showHidden && item.name.startsWith('.') && item.name !== '..') {
      return false;
    }
    if (query && !item.name.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });

  // ソート (常にディレクトリを上にする)
  filteredItems.sort((a, b) => {
    // ディレクトリ優先
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;

    let res = 0;
    if (sortKey === 'name') {
      res = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (sortKey === 'size') {
      res = a.size - b.size;
    } else if (sortKey === 'mtime') {
      res = a.modTime.localeCompare(b.modTime);
    }

    return sortAsc ? res : -res;
  });

  if (selectedIndex >= filteredItems.length) {
    selectedIndex = Math.max(0, filteredItems.length - 1);
  }
}

// --- パンくずリスト描画 ---
function renderBreadcrumbs() {
  const container = document.getElementById('breadcrumbs');
  container.innerHTML = '';

  if (!currentPath) return;

  const parts = currentPath.split('/').filter(Boolean);

  // ルート "/"
  const rootSpan = document.createElement('span');
  rootSpan.className = 'crumb-item';
  rootSpan.textContent = '/';
  rootSpan.title = 'ルート (/)';
  rootSpan.addEventListener('click', () => loadDirectory('/'));
  container.appendChild(rootSpan);

  let accumulated = '';
  parts.forEach((part, i) => {
    accumulated += '/' + part;
    const isLast = (i === parts.length - 1);

    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    container.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = `crumb-item ${isLast ? 'current' : ''}`;
    crumb.textContent = part;
    crumb.title = accumulated;
    if (!isLast) {
      const target = accumulated;
      crumb.addEventListener('click', () => loadDirectory(target));
    }
    container.appendChild(crumb);
  });

  // スクロールを末尾に合わせる
  container.scrollLeft = container.scrollWidth;
}

// --- アイコン判定 ---
function getItemIcon(item) {
  if (item.isDir) {
    return '📁';
  }
  if (item.isSymlink) {
    return '🔗';
  }
  const ext = item.ext.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return '🖼️';
  }
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) {
    return '🎬';
  }
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
    return '🎵';
  }
  if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'].includes(ext)) {
    return '📦';
  }
  if (['go', 'js', 'ts', 'jsx', 'tsx', 'py', 'sh', 'html', 'css', 'json', 'md', 'c', 'cpp', 'rs', 'java', 'sql', 'yaml', 'yml'].includes(ext)) {
    return '📝';
  }
  if (item.mode && item.mode.includes('x')) {
    return '⚙️';
  }
  return '📄';
}

// --- テーブル描画 ---
function renderTable() {
  const tbody = document.getElementById('file-tbody');
  tbody.innerHTML = '';

  const emptyEl = document.getElementById('empty-message');

  if (filteredItems.length === 0) {
    emptyEl.style.display = 'flex';
    updateStatusBar();
    return;
  }
  emptyEl.style.display = 'none';

  filteredItems.forEach((item, index) => {
    const tr = document.createElement('tr');
    const isCut = clipboard.action === 'cut' && item.path === clipboard.path;
    tr.className = `file-row ${item.isDir ? 'is-dir' : ''} ${item.isSymlink ? 'is-symlink' : ''} ${index === selectedIndex ? 'selected' : ''} ${isCut ? 'is-cut' : ''}`;
    tr.dataset.index = index;

    // 名前セル
    const tdName = document.createElement('td');
    tdName.className = 'cell-name';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'item-icon';
    iconSpan.textContent = getItemIcon(item);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-text';
    nameSpan.textContent = item.name + (item.isDir ? '/' : '');

    tdName.appendChild(iconSpan);
    tdName.appendChild(nameSpan);

    if (item.isSymlink && item.symlinkTarget) {
      const arrowSpan = document.createElement('span');
      arrowSpan.className = 'symlink-arrow';
      arrowSpan.textContent = '→';
      const targetSpan = document.createElement('span');
      targetSpan.className = 'symlink-target';
      targetSpan.textContent = item.symlinkTarget;
      tdName.appendChild(arrowSpan);
      tdName.appendChild(targetSpan);
    }

    // サイズセル
    const tdSize = document.createElement('td');
    tdSize.className = 'cell-size';
    tdSize.textContent = item.isDir ? '-' : item.sizeHuman;

    // 更新日時セル
    const tdMtime = document.createElement('td');
    tdMtime.className = 'cell-mtime';
    tdMtime.textContent = item.modTime;

    // 権限セル
    const tdMode = document.createElement('td');
    tdMode.className = 'cell-mode';
    tdMode.textContent = item.mode;

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdMtime);
    tr.appendChild(tdMode);

    // クリックで選択 (同じ項目を再タップした場合は開く)
    tr.addEventListener('click', () => {
      if (selectedIndex === index) {
        openCurrentItem();
      } else {
        setSelectedIndex(index);
      }
    });

    // ダブルクリックで入る/開く (PC向け)
    tr.addEventListener('dblclick', () => {
      openCurrentItem();
    });

    tbody.appendChild(tr);
  });

  updateStatusBar();
  scrollToSelected();
}

// --- 選択変更 ---
function setSelectedIndex(index) {
  if (filteredItems.length === 0) return;
  selectedIndex = Math.max(0, Math.min(filteredItems.length - 1, index));

  const rows = document.querySelectorAll('.file-row');
  rows.forEach((row, i) => {
    row.classList.toggle('selected', i === selectedIndex);
  });

  updateStatusBar();
  scrollToSelected();
}

// --- 選択行までスクロール ---
function scrollToSelected() {
  const selectedRow = document.querySelector('.file-row.selected');
  if (selectedRow) {
    selectedRow.scrollIntoView({ block: 'nearest' });
  }
}

// --- 開く/フォルダに入る (Enter / →) ---
function openCurrentItem() {
  if (filteredItems.length === 0) return;
  const item = filteredItems[selectedIndex];
  if (!item) return;

  if (item.isDir) {
    loadDirectory(item.path);
  } else {
    // ファイルの場合は種別に応じて開く (.md -> marker, その他 -> edit)
    openFileItem(item);
  }
}

// --- 親階層へ移動 (←) ---
function navigateToParent() {
  if (parentPath && parentPath !== currentPath) {
    const oldPath = currentPath;
    loadDirectory(parentPath, oldPath);
  }
}

// --- edit でファイルを開く ---
function openInEdit(filePath) {
  const host = location.hostname || 'localhost';
  const editUrl = `http://${host}:8081/?file=${encodeURIComponent(filePath)}`;
  window.open(editUrl, '_blank');
}

// --- marker で Markdown を開く (ポート 8083) ---
function openInMarker(filePath) {
  const host = location.hostname || 'localhost';
  const markerUrl = `http://${host}:8083/?file=${encodeURIComponent(filePath)}`;
  window.open(markerUrl, '_blank');
}

// --- paint で画像を開く (ポート 8084) ---
function openInPaint(filePath) {
  const host = location.hostname || 'localhost';
  const paintUrl = `http://${host}:8084/?file=${encodeURIComponent(filePath)}`;
  window.open(paintUrl, '_blank');
}

// --- ファイル種別に応じて適切なアプリで開く ---
function openFileItem(item) {
  if (!item) return;
  const ext = (item.ext || '').toLowerCase();
  const name = (item.name || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown' || name.endsWith('.md')) {
    openInMarker(item.path);
  } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    openInPaint(item.path);
  } else {
    openInEdit(item.path);
  }
}

// --- webterm で端末を開く (t) ---
function openInWebterm(dirPath) {
  const host = location.hostname || 'localhost';
  const termUrl = `http://${host}:8080/?cwd=${encodeURIComponent(dirPath)}`;
  window.open(termUrl, '_blank');
}

// --- ステータスバー更新 ---
function updateStatusBar() {
  const selEl = document.getElementById('status-selection');
  const countEl = document.getElementById('status-counts');

  if (filteredItems.length === 0) {
    selEl.textContent = '項目なし';
    countEl.textContent = `0 項目`;
    return;
  }

  const item = filteredItems[selectedIndex];
  if (item) {
    const sizeStr = item.isDir ? 'フォルダ' : item.sizeHuman;
    selEl.textContent = `${item.name} (${sizeStr}) - ${item.mode}`;
    countEl.textContent = `${selectedIndex + 1} / ${filteredItems.length} 項目 (全 ${allItems.length})`;
  }

  const clipEl = document.getElementById('status-clipboard');
  if (clipEl) {
    if (clipboard.path) {
      clipEl.style.display = 'inline-flex';
      const icon = clipboard.action === 'copy' ? '📋' : '✂️';
      clipEl.textContent = `${icon} ${clipboard.name}`;
      clipEl.title = `${clipboard.action === 'copy' ? 'コピー中' : '移動中'}: ${clipboard.path} (p: 貼り付け)`;
    } else {
      clipEl.style.display = 'none';
    }
  }

  updateMobileToolbar();
}

// --- モバイルツールバーの表示更新 ---
function updateMobileToolbar() {
  const item = filteredItems[selectedIndex];
  const openIcon = document.getElementById('mbtn-open-icon');
  const openLabel = document.getElementById('mbtn-open-label');
  if (openIcon && openLabel) {
    if (item && item.isDir) {
      openIcon.textContent = '📂';
      openLabel.textContent = '開く';
    } else {
      const ext = (item?.ext || '').toLowerCase();
      const name = (item?.name || '').toLowerCase();
      if (ext === 'md' || ext === 'markdown' || name.endsWith('.md')) {
        openIcon.textContent = '📝';
        openLabel.textContent = 'Marker';
      } else {
        openIcon.textContent = '✏️';
        openLabel.textContent = '編集';
      }
    }
  }

  const pasteBtn = document.getElementById('mbtn-paste');
  if (pasteBtn) {
    pasteBtn.classList.toggle('has-clipboard', !!clipboard.path);
  }

  const parentBtn = document.getElementById('btn-parent');
  const mbtnParent = document.getElementById('mbtn-parent');
  const isRoot = !parentPath || parentPath === currentPath;
  if (parentBtn) {
    parentBtn.disabled = isRoot;
    parentBtn.style.opacity = isRoot ? '0.35' : '1';
  }
  if (mbtnParent) {
    mbtnParent.disabled = isRoot;
    mbtnParent.style.opacity = isRoot ? '0.35' : '1';
  }
}

// --- トースト通知 ---
let toastTimeout = null;
function showToast(message, duration = 2200) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.style.display = 'none';
  }, duration);
}

// --- モーダル (入力/確認) ---
function showPromptModal({ title, initialValue = '', hint = '', selectRange = null, onConfirm }) {
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const msgEl = document.getElementById('modal-message');
  const inputEl = document.getElementById('modal-input');
  const hintEl = document.getElementById('modal-hint');
  const btnConfirm = document.getElementById('modal-btn-confirm');

  titleEl.textContent = title;
  msgEl.style.display = 'none';
  inputEl.style.display = 'block';
  inputEl.value = initialValue;
  hintEl.textContent = hint;
  hintEl.style.display = hint ? 'block' : 'none';
  btnConfirm.textContent = '決定 (Enter)';
  btnConfirm.className = 'btn btn-primary';

  overlay.style.display = 'flex';
  isModalOpen = true;

  inputEl.focus();
  if (selectRange) {
    inputEl.setSelectionRange(selectRange.start, selectRange.end);
  } else {
    inputEl.select();
  }

  modalCallback = async () => {
    const val = inputEl.value.trim();
    if (!val) return;
    const ok = await onConfirm(val);
    if (ok) closeModal();
  };
}

function showConfirmModal({ title, message, isDanger = false, onConfirm }) {
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const msgEl = document.getElementById('modal-message');
  const inputEl = document.getElementById('modal-input');
  const hintEl = document.getElementById('modal-hint');
  const btnConfirm = document.getElementById('modal-btn-confirm');

  titleEl.textContent = title;
  msgEl.textContent = message;
  msgEl.style.display = 'block';
  inputEl.style.display = 'none';
  hintEl.textContent = 'Enter または y で実行、Esc でキャンセル';
  hintEl.style.display = 'block';
  btnConfirm.textContent = isDanger ? '削除 (Enter)' : '決定 (Enter)';
  btnConfirm.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';

  overlay.style.display = 'flex';
  isModalOpen = true;
  btnConfirm.focus();

  modalCallback = async () => {
    const ok = await onConfirm();
    if (ok) closeModal();
  };
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.style.display = 'none';
  isModalOpen = false;
  modalCallback = null;
}

function toggleHelpModal(show) {
  const helpOverlay = document.getElementById('help-overlay');
  if (show === undefined) {
    isHelpOpen = !isHelpOpen;
  } else {
    isHelpOpen = show;
  }
  helpOverlay.style.display = isHelpOpen ? 'flex' : 'none';
}

// --- 新規作成 (a / n) ---
function promptCreate() {
  showPromptModal({
    title: '新規作成 (ファイル / フォルダ)',
    initialValue: '',
    hint: '末尾に / を付けるとフォルダを作成します (例: folder/)',
    onConfirm: async (name) => {
      try {
        const res = await fetch('/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cwd: currentPath,
            name: name,
            isDir: name.endsWith('/')
          })
        });
        if (!res.ok) {
          const err = await res.text();
          alert('作成に失敗しました: ' + err);
          return false;
        }
        const data = await res.json();
        showToast(`✨ 作成しました: ${name}`);
        await loadDirectory(currentPath, data.path);
        return true;
      } catch (e) {
        alert('通信エラー: ' + e.message);
        return false;
      }
    }
  });
}

// --- リネーム (c / F2 / R) ---
function promptRename() {
  if (filteredItems.length === 0) return;
  const item = filteredItems[selectedIndex];
  if (!item) return;

  const dotIdx = item.isDir ? -1 : item.name.lastIndexOf('.');
  const selectRange = (dotIdx > 0) ? { start: 0, end: dotIdx } : null;

  showPromptModal({
    title: `名前の変更: ${item.name}`,
    initialValue: item.name,
    hint: '新しい名前を入力してください',
    selectRange: selectRange,
    onConfirm: async (newName) => {
      if (newName === item.name) return true;
      try {
        const res = await fetch('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldPath: item.path,
            newName: newName
          })
        });
        if (!res.ok) {
          const err = await res.text();
          alert('名前の変更に失敗しました: ' + err);
          return false;
        }
        const data = await res.json();
        showToast(`✏️ リネームしました: ${newName}`);
        if (clipboard.path === item.path) {
          clipboard.path = data.path;
          clipboard.name = newName;
        }
        await loadDirectory(currentPath, data.path);
        return true;
      } catch (e) {
        alert('通信エラー: ' + e.message);
        return false;
      }
    }
  });
}

// --- 削除 (d / Delete) ---
function promptDelete() {
  if (filteredItems.length === 0) return;
  const item = filteredItems[selectedIndex];
  if (!item) return;

  const typeLabel = item.isDir ? 'フォルダ' : 'ファイル';
  showConfirmModal({
    title: `${typeLabel}の削除`,
    message: `「${item.name}」をゴミ箱に移動しますか？`,
    isDanger: true,
    onConfirm: async () => {
      try {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: item.path })
        });
        if (!res.ok) {
          const err = await res.text();
          alert('削除に失敗しました: ' + err);
          return false;
        }
        const data = await res.json();
        const actionStr = data.trashed ? 'ゴミ箱へ移動しました' : '削除しました';
        showToast(`🗑️ ${actionStr}: ${item.name}`);
        if (clipboard.path === item.path) {
          clearClipboard();
        }
        await loadDirectory(currentPath);
        return true;
      } catch (e) {
        alert('通信エラー: ' + e.message);
        return false;
      }
    }
  });
}

// --- コピー (y / Ctrl+C) ---
function copySelection() {
  if (filteredItems.length === 0) return;
  const item = filteredItems[selectedIndex];
  if (!item) return;

  clipboard = {
    action: 'copy',
    path: item.path,
    name: item.name,
    isDir: item.isDir
  };
  showToast(`📋 コピーしました: ${item.name}`);
  updateStatusBar();
  renderTable();
}

// --- 切り取り (x / Ctrl+X) ---
function cutSelection() {
  if (filteredItems.length === 0) return;
  const item = filteredItems[selectedIndex];
  if (!item) return;

  clipboard = {
    action: 'cut',
    path: item.path,
    name: item.name,
    isDir: item.isDir
  };
  showToast(`✂️ 切り取りました: ${item.name}`);
  updateStatusBar();
  renderTable();
}

function clearClipboard() {
  clipboard = { action: null, path: '', name: '', isDir: false };
  updateStatusBar();
  renderTable();
}

// --- 貼り付け (p / Ctrl+V) ---
async function pasteSelection() {
  if (!clipboard.path) {
    showToast('クリップボードは空です');
    return;
  }

  try {
    const res = await fetch('/api/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: clipboard.action,
        srcPath: clipboard.path,
        destDir: currentPath
      })
    });
    if (!res.ok) {
      const err = await res.text();
      alert('貼り付けに失敗しました: ' + err);
      return;
    }
    const data = await res.json();
    const actionLabel = clipboard.action === 'move' || clipboard.action === 'cut' ? '移動しました' : '貼り付けました';
    showToast(`✅ ${actionLabel}: ${basename(data.destPath)}`);

    if (clipboard.action === 'cut') {
      clipboard = { action: null, path: '', name: '', isDir: false };
    }
    await loadDirectory(currentPath, data.destPath);
  } catch (e) {
    alert('通信エラー: ' + e.message);
  }
}

// --- 複製 (D / Ctrl+D) ---
async function duplicateSelection() {
  if (filteredItems.length === 0) return;
  const item = filteredItems[selectedIndex];
  if (!item) return;

  try {
    const res = await fetch('/api/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: item.path })
    });
    if (!res.ok) {
      const err = await res.text();
      alert('複製に失敗しました: ' + err);
      return;
    }
    const data = await res.json();
    showToast(`📑 複製しました: ${basename(data.destPath)}`);
    await loadDirectory(currentPath, data.destPath);
  } catch (e) {
    alert('通信エラー: ' + e.message);
  }
}

// --- イベント登録 ---
function setupEvents() {
  const filterInput = document.getElementById('filter-input');
  const filterClear = document.getElementById('filter-clear');
  const pathInput = document.getElementById('path-input');
  const breadcrumbs = document.getElementById('breadcrumbs');

  // キーボード操作 (メイン)
  window.addEventListener('keydown', (e) => {
    // 1. モーダル表示中のキー処理
    if (isModalOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (modalCallback) modalCallback();
      } else if (!document.getElementById('modal-input').offsetParent && (e.key === 'y' || e.key === 'Y')) {
        // 確認モーダルで入力欄がない場合、y で確定
        e.preventDefault();
        if (modalCallback) modalCallback();
      }
      return;
    }

    // 2. ヘルプモーダル表示中のキー処理
    if (isHelpOpen) {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        toggleHelpModal(false);
      }
      return;
    }

    const isInputFocused = (document.activeElement === filterInput || document.activeElement === pathInput);

    // 3. 検索入力やパス入力を解除してリストに戻る (Esc)
    if (isInputFocused) {
      if (e.key === 'Escape') {
        if (document.activeElement === filterInput) {
          filterInput.value = '';
          filterClear.style.display = 'none';
          filterInput.blur();
          applyFilterAndSort();
          renderTable();
        }
        if (pathInput.style.display !== 'none') {
          pathInput.style.display = 'none';
          breadcrumbs.style.display = 'flex';
        }
        return;
      }

      // 入力フォーカス中の場合、Enterで実行
      if (e.key === 'Enter') {
        if (document.activeElement === filterInput) {
          filterInput.blur();
          openCurrentItem();
        } else if (document.activeElement === pathInput) {
          const p = pathInput.value.trim();
          pathInput.style.display = 'none';
          breadcrumbs.style.display = 'flex';
          if (p) loadDirectory(p);
        }
      }
      return;
    }

    // Esc キー: 切り取り (Cut) 状態の解除
    if (e.key === 'Escape') {
      if (clipboard.action === 'cut') {
        clearClipboard();
        showToast('切り取りを解除しました');
      }
      return;
    }

    // --- ここからリスト操作ショートカット ---

    // 下移動
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setSelectedIndex(selectedIndex + 1);
    }
    // 上移動
    else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setSelectedIndex(selectedIndex - 1);
    }
    // 右移動 / Enter: フォルダに入る or ファイルを開く
    else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === 'l') {
      e.preventDefault();
      openCurrentItem();
    }
    // 左移動: 親ディレクトリへ移動
    else if (e.key === 'ArrowLeft' || e.key === 'h' || e.key === 'Backspace') {
      e.preventDefault();
      navigateToParent();
    }
    // 先頭 / 末尾ジャンプ
    else if (e.key === 'Home') {
      e.preventDefault();
      setSelectedIndex(0);
    }
    else if (e.key === 'End') {
      e.preventDefault();
      setSelectedIndex(filteredItems.length - 1);
    }
    // 検索フィルタにフォーカス (/)
    else if (e.key === '/') {
      e.preventDefault();
      filterInput.focus();
      filterInput.select();
    }
    // 隠しファイル切替 (.)
    else if (e.key === '.') {
      e.preventDefault();
      toggleHidden();
    }
    // ターミナルで開く (t)
    else if (e.key === 't') {
      e.preventDefault();
      openInWebterm(currentPath);
    }
    // 編集で開く (e)
    else if (e.key === 'e') {
      e.preventDefault();
      const item = filteredItems[selectedIndex];
      if (item && !item.isDir) {
        openFileItem(item);
      }
    }
    // 更新 (r)
    else if (e.key === 'r') {
      e.preventDefault();
      loadDirectory(currentPath);
    }
    // 新規作成 (a / n)
    else if (e.key === 'a' || e.key === 'n') {
      e.preventDefault();
      promptCreate();
    }
    // 名前変更 (c / F2 / R)
    else if (e.key === 'c' || e.key === 'F2' || (e.shiftKey && e.key === 'R')) {
      e.preventDefault();
      promptRename();
    }
    // 削除 (d / Delete)
    else if (e.key === 'd' || e.key === 'Delete') {
      e.preventDefault();
      promptDelete();
    }
    // コピー (y / Ctrl+C)
    else if (e.key === 'y' || ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C'))) {
      e.preventDefault();
      copySelection();
    }
    // 切り取り (x / Ctrl+X)
    else if (e.key === 'x' || ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X'))) {
      e.preventDefault();
      cutSelection();
    }
    // 貼り付け (p / Ctrl+V)
    else if (e.key === 'p' || ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V'))) {
      e.preventDefault();
      pasteSelection();
    }
    // 複製 (D / Ctrl+D)
    else if ((e.shiftKey && e.key === 'D') || ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D'))) {
      e.preventDefault();
      duplicateSelection();
    }
    // ヘルプ表示 (?)
    else if (e.key === '?') {
      e.preventDefault();
      toggleHelpModal(true);
    }
  });

  // モーダル操作イベント
  const modalCloseBtn = document.getElementById('modal-close');
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
  const modalCancelBtn = document.getElementById('modal-btn-cancel');
  if (modalCancelBtn) modalCancelBtn.addEventListener('click', closeModal);
  const modalConfirmBtn = document.getElementById('modal-btn-confirm');
  if (modalConfirmBtn) modalConfirmBtn.addEventListener('click', () => {
    if (modalCallback) modalCallback();
  });
  const modalOverlay = document.getElementById('modal-overlay');
  if (modalOverlay) modalOverlay.addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  // ヘルプモーダルイベント
  const helpCloseBtn = document.getElementById('help-close');
  if (helpCloseBtn) helpCloseBtn.addEventListener('click', () => toggleHelpModal(false));
  const helpOverlay = document.getElementById('help-overlay');
  if (helpOverlay) helpOverlay.addEventListener('click', (e) => {
    if (e.target.id === 'help-overlay') toggleHelpModal(false);
  });

  // フィルタ入力イベント
  filterInput.addEventListener('input', () => {
    filterClear.style.display = filterInput.value ? 'block' : 'none';
    applyFilterAndSort();
    selectedIndex = 0;
    renderTable();
  });

  filterClear.addEventListener('click', () => {
    filterInput.value = '';
    filterClear.style.display = 'none';
    applyFilterAndSort();
    renderTable();
    filterInput.focus();
  });

  // 隠しファイル切替ボタン
  document.getElementById('btn-hidden').addEventListener('click', toggleHidden);

  // ターミナルボタン
  document.getElementById('btn-term').addEventListener('click', () => {
    openInWebterm(currentPath);
  });

  // 更新ボタン
  document.getElementById('btn-refresh').addEventListener('click', () => {
    loadDirectory(currentPath);
  });

  // テーマ切替
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // 親ディレクトリボタン & モバイルツールバー
  const btnParent = document.getElementById('btn-parent');
  if (btnParent) btnParent.addEventListener('click', navigateToParent);

  const mbtnParent = document.getElementById('mbtn-parent');
  if (mbtnParent) mbtnParent.addEventListener('click', navigateToParent);

  const mbtnOpen = document.getElementById('mbtn-open');
  if (mbtnOpen) mbtnOpen.addEventListener('click', openCurrentItem);

  const mbtnNew = document.getElementById('mbtn-new');
  if (mbtnNew) mbtnNew.addEventListener('click', promptCreate);

  const mbtnRename = document.getElementById('mbtn-rename');
  if (mbtnRename) mbtnRename.addEventListener('click', promptRename);

  const mbtnCopy = document.getElementById('mbtn-copy');
  if (mbtnCopy) mbtnCopy.addEventListener('click', copySelection);

  const mbtnCut = document.getElementById('mbtn-cut');
  if (mbtnCut) mbtnCut.addEventListener('click', cutSelection);

  const mbtnPaste = document.getElementById('mbtn-paste');
  if (mbtnPaste) mbtnPaste.addEventListener('click', pasteSelection);

  const mbtnDelete = document.getElementById('mbtn-delete');
  if (mbtnDelete) mbtnDelete.addEventListener('click', promptDelete);

  const mbtnTerm = document.getElementById('mbtn-term');
  if (mbtnTerm) mbtnTerm.addEventListener('click', () => openInWebterm(currentPath));

  // パスコピー
  setupCopyPath();

  // パンくずのダブルクリックでパス直接入力モード
  breadcrumbs.addEventListener('dblclick', () => {
    breadcrumbs.style.display = 'none';
    pathInput.style.display = 'inline-block';
    pathInput.value = currentPath;
    pathInput.focus();
    pathInput.select();
  });

  pathInput.addEventListener('blur', () => {
    pathInput.style.display = 'none';
    breadcrumbs.style.display = 'flex';
  });

  // ソートヘッダークリック
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortAsc = !sortAsc;
      } else {
        sortKey = key;
        sortAsc = true;
      }
      localStorage.setItem('filer_sort_key', sortKey);
      localStorage.setItem('filer_sort_asc', sortAsc.toString());
      updateSortHeadersUI();
      applyFilterAndSort();
      renderTable();
    });
  });
}

// --- ソートヘッダーUI ---
function updateSortHeadersUI() {
  document.querySelectorAll('th.sortable').forEach(th => {
    const key = th.dataset.sort;
    const arrow = th.querySelector('.sort-arrow');
    if (sortKey === key) {
      arrow.textContent = sortAsc ? '▲' : '▼';
    } else {
      arrow.textContent = '';
    }
  });
}

// --- 隠しファイル表示切替 ---
function toggleHidden() {
  showHidden = !showHidden;
  localStorage.setItem('filer_show_hidden', showHidden.toString());
  updateHiddenToggleUI();
  applyFilterAndSort();
  renderTable();
}

function updateHiddenToggleUI() {
  const btn = document.getElementById('btn-hidden');
  if (btn) {
    btn.classList.toggle('active', showHidden);
  }
}

// --- パスコピー機能 ---
function setupCopyPath() {
  const btn = document.getElementById('btn-copy-path');
  const copySvg = btn.querySelector('.copy-svg');
  const checkSvg = btn.querySelector('.check-svg');
  const tooltip = document.getElementById('copy-tooltip');

  let copyTimeout = null;

  btn.addEventListener('click', async () => {
    if (!currentPath) return;
    const ok = await copyToClipboard(currentPath);
    if (!ok) return;

    if (copyTimeout) clearTimeout(copyTimeout);

    btn.classList.add('copied');
    copySvg.style.display = 'none';
    checkSvg.style.display = 'inline-block';
    tooltip.classList.add('show');

    copyTimeout = setTimeout(() => {
      btn.classList.remove('copied');
      copySvg.style.display = 'inline-block';
      checkSvg.style.display = 'none';
      tooltip.classList.remove('show');
    }, 1500);
  });
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch (err) {
    return false;
  }
}

// --- テーマ切替 ---
function toggleTheme() {
  currentTheme = currentTheme === 'theme-dark' ? 'theme-light' : 'theme-dark';
  applyTheme(currentTheme);
  localStorage.setItem('filer_theme', currentTheme);
}

function applyTheme(theme) {
  document.body.className = theme;
}

// --- ヘルパー ---
function showLoading(show) {
  const loader = document.getElementById('loading-indicator');
  if (loader) loader.style.display = show ? 'flex' : 'none';
}

function basename(path) {
  if (!path || path === '/') return '';
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

document.addEventListener('DOMContentLoaded', init);
