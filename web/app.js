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
    tr.className = `file-row ${item.isDir ? 'is-dir' : ''} ${item.isSymlink ? 'is-symlink' : ''} ${index === selectedIndex ? 'selected' : ''}`;
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

    // クリックで選択
    tr.addEventListener('click', () => {
      setSelectedIndex(index);
    });

    // ダブルクリックで入る/開く
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
    // ファイルの場合は edit (ポート 8081) で開く
    openInEdit(item.path);
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
  const editUrl = `http://localhost:8081/?file=${encodeURIComponent(filePath)}`;
  window.open(editUrl, '_blank');
}

// --- webterm で端末を開く (t) ---
function openInWebterm(dirPath) {
  const termUrl = `http://localhost:8080/?cwd=${encodeURIComponent(dirPath)}`;
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
}

// --- イベント登録 ---
function setupEvents() {
  const filterInput = document.getElementById('filter-input');
  const filterClear = document.getElementById('filter-clear');
  const pathInput = document.getElementById('path-input');
  const breadcrumbs = document.getElementById('breadcrumbs');

  // キーボード操作 (メイン)
  window.addEventListener('keydown', (e) => {
    const isInputFocused = (document.activeElement === filterInput || document.activeElement === pathInput);

    // Esc キー: 検索入力やパス入力を解除してリストに戻る
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
    if (isInputFocused) {
      if (e.key === 'Enter') {
        if (document.activeElement === filterInput) {
          // 絞り込み入力から Enter で先頭の項目を開く
          filterInput.blur();
          openCurrentItem();
        } else if (document.activeElement === pathInput) {
          // パス直接入力
          const p = pathInput.value.trim();
          pathInput.style.display = 'none';
          breadcrumbs.style.display = 'flex';
          if (p) loadDirectory(p);
        }
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
        openInEdit(item.path);
      }
    }
    // 更新 (r)
    else if (e.key === 'r') {
      e.preventDefault();
      loadDirectory(currentPath);
    }
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
