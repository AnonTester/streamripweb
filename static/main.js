function loadAppPrefs() {
  try {
    return JSON.parse(localStorage.getItem('appPrefs') || '{}');
  } catch (e) {
    return {};
  }
}

function saveAppPrefs(prefs) {
  localStorage.setItem('appPrefs', JSON.stringify(prefs));
}

const state = {
  results: [],
  queue: [],
  saved: window.initialSaved || [],
  config: window.initialConfig || {},
  progress: {},
  history: window.initialHistory || [],
  appSettings: { ...(window.initialAppSettings || {}), ...loadAppPrefs() },
  lastQuery: '',
  hasSearched: false,
};

const tabs = document.querySelectorAll('.tab');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
    tab.classList.add('active');
    const target = document.getElementById(`tab-${tab.dataset.tab}`);
    target.classList.add('active');
  });
});

const toastContainer = document.getElementById('toast-container');
function toast(message, tone = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  if (tone === 'error') el.style.borderColor = '#b91c1c';
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function normalizeArtist(artist) {
  if (!artist) return '';
  if (typeof artist === 'string') return artist;
  if (typeof artist === 'object') {
    return artist.name || artist.artist || artist.title || '';
  }
  return String(artist);
}

function markResultDownloadedByQueueItem(item) {
  let changed = false;
  state.results = state.results.map((res) => {
    if (res.id === String(item.item_id) || res.id === item.item_id) {
      if (res.source === item.source && !res.downloaded) {
        changed = true;
        return { ...res, downloaded: true };
      }
    }
    return res;
  });
  return changed;
}

function updateResultsWithHistory() {
  if (!state.history?.length) return false;
  const historySet = new Set(
    state.history.map((entry) => `${entry.source}:${String(entry.id)}`),
  );
  let changed = false;
  state.results = state.results.map((res) => {
    const key = `${res.source}:${String(res.id)}`;
    if (historySet.has(key) && !res.downloaded) {
      changed = true;
      return { ...res, downloaded: true };
    }
    return res;
  });
  return changed;
}

function renderResults(results) {
  updateResultsWithHistory();
  const tbody = document.querySelector('#results-table tbody');
  const actions = document.querySelector('.results-actions');
  const selectionGroup = document.querySelector('.selection-group');
  const actionGroup = document.querySelector('.action-group');
  const tableWrapper = document.querySelector('.table-wrapper');
  const empty = document.getElementById('results-empty');
  if (state.hasSearched || results.length) {
    document.getElementById('results-card')?.classList.remove('hidden');
  }
  tbody.innerHTML = '';
  const hasResults = results.length > 0;
  actions.hidden = !hasResults;
  if (selectionGroup) selectionGroup.hidden = !hasResults;
  if (actionGroup) actionGroup.hidden = !hasResults;
  tableWrapper.hidden = !hasResults;
  empty.hidden = hasResults || !state.hasSearched;
  if (!hasResults && state.hasSearched) {
    empty.textContent = state.lastQuery
      ? `No results found for "${state.lastQuery}".`
      : '';
  }
  results.forEach((row, idx) => {
    const tr = document.createElement('tr');
    const isDownloaded = Boolean(row.downloaded);
    if (isDownloaded) tr.classList.add('downloaded');
    tr.dataset.id = row.id;
    tr.dataset.index = idx;
    const artist = normalizeArtist(row.artist);
    const downloadedPill = isDownloaded ? '<span class="pill pill-downloaded">Downloaded</span>' : '';
    tr.innerHTML = `
      <td><input type="checkbox" data-index="${idx}" data-downloaded="${isDownloaded}" title="${isDownloaded ? 'Select again if desired' : 'Select for download'}"></td>
      <td>${artist}</td>
      <td>${row.title || row.summary} ${downloadedPill}</td>
      <td>${row.year || ''}</td>
      <td>${row.album_type || row.media_type || ''}</td>
      <td>${row.tracks || ''}</td>
      <td>${row.explicit ? '⚠️' : ''}</td>
      <td>${row.source || ''}</td>
    `;
    tbody.appendChild(tr);
  });
  updateDownloadVisibility();
}

function updateDownloadVisibility() {
  const checked = Array.from(document.querySelectorAll('#results-table tbody input[type="checkbox"]:checked'));
  document.getElementById('download-btn').hidden = checked.length === 0;
}

function setCheckboxes(handler, options = {}) {
  const { includeDownloaded = true } = options;
  document.querySelectorAll('#results-table tbody tr').forEach((tr) => {
    const checkbox = tr.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    const result = state.results[Number(checkbox.dataset.index)];
    if (!includeDownloaded && checkbox.dataset.downloaded === 'true') return;
    handler(checkbox, result, tr);
  });
  updateDownloadVisibility();
}

document.getElementById('select-all').addEventListener('click', () => {
  setCheckboxes((box, result) => {
    if (result.downloaded) { box.checked = false; return; }
    box.checked = true;
  }, { includeDownloaded: false });
});

document.getElementById('select-none').addEventListener('click', () => {
  setCheckboxes((box) => { box.checked = false; });
});

document.getElementById('select-invert').addEventListener('click', () => {
  setCheckboxes((box, result) => {
    if (result.downloaded) { box.checked = false; return; }
    box.checked = !box.checked;
  }, { includeDownloaded: false });
});

const tbody = document.querySelector('#results-table tbody');
tbody.addEventListener('change', (ev) => {
  if (ev.target.matches('input[type="checkbox"]')) {
    updateDownloadVisibility();
  }
});

const searchForm = document.getElementById('search-form');
const queryInput = document.getElementById('search-query');
const sourceSelect = searchForm.querySelector('select[name="source"]');
const searchLoadingBanner = document.getElementById('search-loading');
const searchLoadingText = document.getElementById('search-loading-text');
const searchSubmitBtn = searchForm.querySelector('button[type="submit"]');

function applyDefaultSource() {
  if (state.appSettings.defaultSource && sourceSelect) {
    sourceSelect.value = state.appSettings.defaultSource;
  }
}

applyDefaultSource();

function setSearchLoading(isLoading, message = 'Fetching results…') {
  if (!searchLoadingBanner) return;
  searchLoadingBanner.classList.toggle('hidden', !isLoading);
  if (searchLoadingText) searchLoadingText.textContent = message;
  if (searchSubmitBtn) {
    searchSubmitBtn.disabled = isLoading;
    searchSubmitBtn.textContent = isLoading ? 'Searching…' : 'Search';
  }
  searchForm.querySelectorAll('input, select, button').forEach((el) => {
    el.disabled = isLoading;
  });
  document.getElementById('results-card')?.classList.remove('hidden');
}

searchForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const formData = new FormData(searchForm);
  const payload = Object.fromEntries(formData.entries());
  payload.limit = Number(payload.limit || 25);
  state.lastQuery = payload.query;
  state.hasSearched = true;
  setSearchLoading(true);
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Search failed (${res.status})`);
    }
    const data = await res.json();
    state.results = data.results || [];
    updateResultsWithHistory();
    renderResults(state.results);
    toast(`Loaded ${state.results.length} results`);
  } catch (err) {
    console.error('Search failed', err);
    toast('Search failed. Please try again.', 'error');
  } finally {
    setSearchLoading(false);
  }
});

function buildQueueRow(item) {
  const progress = state.progress[item.job_id];
  const overall = progress?.overall || { received: 0, total: 0 };
  const total = overall.total || 0;
  const received = overall.received || 0;
  const pct = item.status === 'completed'
    ? 100
    : total
      ? Math.min(100, Math.round((received / total) * 100))
      : 0;
  const eta = overall.eta != null ? `${Math.max(0, Math.round(overall.eta))}s` : '—';
  const statusLabel = item.status === 'completed'
    ? 'Completed'
    : item.status === 'failed'
      ? 'Failed'
      : pct
        ? `${pct}%`
        : item.status.replace('_', ' ');
  const trackProgress = progress?.progress || {};
  const trackTotal = trackProgress.total || 0;
  const trackReceived = trackProgress.received || 0;
  const trackPct = trackTotal ? Math.min(100, Math.round((trackReceived / trackTotal) * 100)) : 0;
  const trackEta = trackProgress.eta != null ? `${Math.max(0, Math.round(trackProgress.eta))}s` : '—';
  const trackLabel = progress?.track?.title || trackProgress.desc || '—';
  const div = document.createElement('div');
  div.className = 'queue-item';
  div.innerHTML = `
    <div class="queue-header">
      <div>
        <strong>${item.title}</strong><div class="muted">${normalizeArtist(item.artist) || ''}</div>
      </div>
      <div class="status ${item.status}">${statusLabel}</div>
    </div>
    <div class="muted">Attempts: ${item.attempts || 0}${item.error ? ` · ${item.error}` : ''}</div>
    <div class="progress-bar"><span style="width:${pct}%;"></span></div>
    <div class="muted">Overall ETA: ${eta}</div>
    <div class="muted">Track: ${trackLabel} · ${trackPct ? `${trackPct}%` : '—'} · ETA ${trackEta}</div>
    <div class="progress-bar"><span style="width:${trackPct}%;"></span></div>
    <div class="stack action-row">
      <button class="btn ghost" data-action="retry" data-id="${item.job_id}">Retry</button>
      <button class="btn ghost" data-action="save" data-id="${item.job_id}">Save for later</button>
      <button class="btn danger" data-action="abort" data-id="${item.job_id}">Abort</button>
    </div>
  `;
  return div;
}

function renderQueue(queue, progressMap, history) {
  const prevQueue = state.queue || [];
  const incomingQueue = queue || state.queue;
  if (progressMap) {
    state.progress = progressMap;
  }
  if (history) {
    state.history = history;
  }
  state.queue = incomingQueue;
  if (state.queue.length) {
    document.getElementById('results-card')?.classList.remove('hidden');
  }
  const list = document.getElementById('queue-list');
  list.innerHTML = '';
  let resultsUpdated = false;
  if (!state.queue.length && prevQueue.length) {
    prevQueue.forEach((item) => {
      if (item.status === 'completed') {
        resultsUpdated = markResultDownloadedByQueueItem(item) || resultsUpdated;
      }
    });
  }
  state.queue.forEach((item) => {
    const progress = state.progress[item.job_id];
    const status = progress && item.status !== 'completed' && item.status !== 'failed'
      ? 'in_progress'
      : item.status;
    const normalizedItem = { ...item, status };
    if (status === 'completed') {
      resultsUpdated = markResultDownloadedByQueueItem(normalizedItem) || resultsUpdated;
    }
    list.appendChild(buildQueueRow(normalizedItem));
  });
  document.getElementById('view-queue').hidden = state.queue.length === 0;
  const historyUpdated = updateResultsWithHistory();
  if (resultsUpdated || historyUpdated) {
    renderResults(state.results);
  }
  if (queue && prevQueue.length > 0 && state.queue.length === 0) {
    const hadFailure = prevQueue.some((item) => ['failed', 'aborted', 'retrying'].includes(item.status));
    if (!hadFailure) {
      toast('All downloads completed successfully');
      const queuePanelEl = document.getElementById('queue-panel');
      const resultsPanelEl = document.getElementById('results-panel');
      queuePanelEl?.classList.add('hidden');
      resultsPanelEl?.classList.remove('hidden');
      renderResults(state.results);
    }
  }
}

function renderSaved(saved) {
  state.saved = saved;
  const list = document.getElementById('saved-list');
  list.innerHTML = '';
  if (!saved.length) {
    list.innerHTML = '<p class="muted">No saved items yet.</p>';
    return;
  }
  saved.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `
      <div class="queue-header">
        <div><strong>${item.title || item.id}</strong><div class="muted">${normalizeArtist(item.artist) || ''}</div></div>
        <div class="muted">${item.source} · ${item.media_type}</div>
      </div>
      <div class="stack action-row">
        <button class="btn primary" data-saved-download="${idx}">Download</button>
        <button class="btn ghost" data-saved-remove="${idx}">Remove</button>
      </div>
    `;
    list.appendChild(row);
  });
}

function createSettingRow(labelText, control) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const label = document.createElement('label');
  label.textContent = labelText;
  if (control.id) label.setAttribute('for', control.id);
  row.append(label, control);
  return row;
}

function buildAppSettingsSection() {
  const sec = document.createElement('div');
  sec.className = 'settings-section';
  sec.innerHTML = '<h3>app</h3>';
  const select = document.createElement('select');
  select.dataset.app = 'defaultSource';
  select.name = 'defaultSource';
  select.id = 'default-source';
  ['qobuz', 'tidal', 'deezer', 'soundcloud'].forEach((src) => {
    const opt = document.createElement('option');
    opt.value = src;
    opt.textContent = src.charAt(0).toUpperCase() + src.slice(1);
    select.appendChild(opt);
  });
  select.value = state.appSettings.defaultSource || 'qobuz';
  const debugToggle = document.createElement('input');
  debugToggle.type = 'checkbox';
  debugToggle.dataset.app = 'debugLogging';
  debugToggle.name = 'debugLogging';
  debugToggle.id = 'debug-logging';
  debugToggle.checked = Boolean(state.appSettings.debugLogging);
  const portInput = document.createElement('input');
  portInput.type = 'number';
  portInput.min = '1';
  portInput.step = '1';
  portInput.dataset.app = 'port';
  portInput.name = 'port';
  portInput.id = 'app-port';
  portInput.value = state.appSettings.port || 8500;
  sec.appendChild(createSettingRow('Default search source', select));
  sec.appendChild(createSettingRow('Enable debug logging', debugToggle));
  sec.appendChild(createSettingRow('Port', portInput));
  return sec;
}

function renderSettings(config) {
  const container = document.getElementById('settings-form');
  const appSettingsContainer = document.getElementById('app-settings-form');
  container.innerHTML = '';
  appSettingsContainer.innerHTML = '';

  appSettingsContainer.appendChild(buildAppSettingsSection());
  Object.entries(config).forEach(([section, values]) => {
    if (section === 'toml' || section === '_modified') return;
    const sec = document.createElement('div');
    sec.className = 'settings-section';
    sec.innerHTML = `<h3>${section}</h3>`;
    Object.entries(values).forEach(([key, value]) => {
      const id = `${section}.${key}`;
      const controlId = `${section}-${key}`;
      let control;
      if (Array.isArray(value)) {
        control = document.createElement('input');
        control.dataset.config = id;
        control.dataset.type = 'list';
        control.value = value.join(', ');
      } else if (typeof value === 'boolean') {
        control = document.createElement('input');
        control.type = 'checkbox';
        control.dataset.config = id;
        control.checked = value;
      } else {
        control = document.createElement('input');
        control.dataset.config = id;
        control.value = value;
      }
      control.id = controlId;
      sec.appendChild(createSettingRow(key, control));
    });
    container.appendChild(sec);
  });
}

renderResults(state.results);
renderSaved(state.saved);
renderSettings(state.config);

const resultsCard = document.getElementById('results-card');
const queuePanel = document.getElementById('queue-panel');
const resultsPanel = document.getElementById('results-panel');
const backToResultsBtn = document.getElementById('back-to-results');
const viewQueueBtn = document.getElementById('view-queue');

document.getElementById('download-btn').addEventListener('click', async () => {
  const selected = Array.from(document.querySelectorAll('#results-table tbody input[type="checkbox"]:checked'))
    .map((box) => state.results[Number(box.dataset.index)]);
  if (!selected.length) return;
  const res = await fetch('/api/downloads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: selected }),
  });
  const data = await res.json();
  renderQueue(data.queue, data.progress, data.history);
  resultsPanel.classList.add('hidden');
  queuePanel.classList.remove('hidden');
});

backToResultsBtn.addEventListener('click', () => {
  queuePanel.classList.add('hidden');
  resultsPanel.classList.remove('hidden');
  renderResults(state.results);
});

viewQueueBtn.addEventListener('click', () => {
  resultsPanel.classList.add('hidden');
  queuePanel.classList.remove('hidden');
});

const queueList = document.getElementById('queue-list');
queueList.addEventListener('click', async (ev) => {
  const action = ev.target.dataset.action;
  const jobId = ev.target.dataset.id;
  if (!action || !jobId) return;
  await fetch(`/api/queue/${jobId}/${action}`, { method: 'POST' });
});

const savedList = document.getElementById('saved-list');
savedList.addEventListener('click', async (ev) => {
  const downloadIdx = ev.target.dataset.savedDownload;
  const removeIdx = ev.target.dataset.savedRemove;
  if (downloadIdx !== undefined) {
    const item = state.saved[Number(downloadIdx)];
    await fetch('/api/saved/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [item] }),
    });
    toast('Starting download from saved');
  }
  if (removeIdx !== undefined) {
    const item = state.saved[Number(removeIdx)];
    await fetch('/api/saved/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    toast('Removed saved item');
    await refreshSaved();
  }
});

document.getElementById('download-saved').addEventListener('click', async () => {
  await fetch('/api/saved/download', { method: 'POST' });
  toast('Queued all saved items');
});

async function refreshSaved() {
  const res = await fetch('/api/saved');
  const data = await res.json();
  renderSaved(data.saved || []);
}

async function refreshQueue() {
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    renderQueue(data.queue || [], data.progress, data.history);
  } catch (err) {
    console.error('Failed to refresh queue', err);
  }
}

function gatherSettingsPayload() {
  const payload = {};
  document.querySelectorAll('[data-config]').forEach((input) => {
    const [section, key] = input.dataset.config.split('.');
    payload[section] = payload[section] || {};
    if (input.type === 'checkbox') {
      payload[section][key] = input.checked;
    } else if (input.dataset.type === 'list') {
      payload[section][key] = input.value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    } else {
      const value = input.value;
      if (value === 'true' || value === 'false') {
        payload[section][key] = value === 'true';
      } else if (!Number.isNaN(Number(value))) {
        payload[section][key] = Number(value);
      } else {
        payload[section][key] = value;
      }
    }
  });
  return payload;
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const payload = gatherSettingsPayload();
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  state.config = data;
  toast('Settings saved');
});

document.getElementById('save-app-settings').addEventListener('click', async () => {
  document.querySelectorAll('[data-app]').forEach((input) => {
    if (input.name === 'defaultSource') {
      state.appSettings.defaultSource = input.value;
    }
    if (input.name === 'debugLogging') {
      state.appSettings.debugLogging = input.checked;
    }
    if (input.name === 'port') {
      const parsed = Number(input.value);
      state.appSettings.port = Number.isFinite(parsed) && parsed > 0 ? parsed : 8500;
    }
  });
  saveAppPrefs(state.appSettings);
  applyDefaultSource();
  const res = await fetch('/api/app-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.appSettings),
  });
  state.appSettings = await res.json();
  toast('App settings saved');
});

function connectSSE() {
  const status = document.getElementById('sse-status');
  const source = new EventSource('/events/downloads');

  source.addEventListener('queue', (event) => {
    const payload = JSON.parse(event.data);
    const data = payload.data || payload.queue || payload;
    renderQueue(data.queue || data, data.progress, data.history);
    const queueItems = data.queue || data;
    const ids = new Set((queueItems || []).map((item) => item.job_id));
    Object.keys(state.progress).forEach((jobId) => {
      if (!ids.has(jobId)) delete state.progress[jobId];
    });
  });

  source.addEventListener('progress', (event) => {
    const payload = JSON.parse(event.data);
    const data = payload.data || payload;
    state.progress[data.job_id] = { overall: data.overall, track: data.track, progress: data.progress };
    state.queue = state.queue.map((item) => (item.job_id === data.job_id ? { ...item, status: item.status === 'completed' ? item.status : 'in_progress' } : item));
    renderQueue(state.queue, state.progress, state.history);
  });

  source.addEventListener('saved', (event) => {
    const payload = JSON.parse(event.data);
    const data = payload.data || payload;
    renderSaved(data);
  });

  source.onerror = () => {
    status.classList.add('error');
    status.textContent = 'Offline';
    toast('SSE connection lost', 'error');
  };

  source.onopen = () => {
    status.classList.remove('error');
    status.textContent = 'Online';
    refreshQueue();
  };
}

connectSSE();
setInterval(refreshQueue, 6000);
