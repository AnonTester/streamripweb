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
  appPrefs: loadAppPrefs(),
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

function renderResults(results) {
  const tbody = document.querySelector('#results-table tbody');
  const actions = document.querySelector('.results-actions');
  const selectionGroup = document.querySelector('.selection-group');
  const actionGroup = document.querySelector('.action-group');
  const tableWrapper = document.querySelector('.table-wrapper');
  const empty = document.getElementById('results-empty');
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
    const checkboxState = isDownloaded ? 'disabled' : '';
    const downloadedPill = isDownloaded ? '<span class="pill pill-downloaded">Downloaded</span>' : '';
    tr.innerHTML = `
      <td><input type="checkbox" data-index="${idx}" ${checkboxState} title="${isDownloaded ? 'Already downloaded' : 'Select for download'}"></td>
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

function setCheckboxes(handler) {
  document.querySelectorAll('#results-table tbody tr').forEach((tr) => {
    const checkbox = tr.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    const result = state.results[Number(checkbox.dataset.index)];
    handler(checkbox, result, tr);
  });
  updateDownloadVisibility();
}

document.getElementById('select-all').addEventListener('click', () => {
  setCheckboxes((box, result) => {
    if (result.downloaded) { box.checked = false; return; }
    box.checked = true;
  });
});

document.getElementById('select-none').addEventListener('click', () => {
  setCheckboxes((box) => { box.checked = false; });
});

document.getElementById('select-invert').addEventListener('click', () => {
  setCheckboxes((box, result) => {
    if (result.downloaded) { box.checked = false; return; }
    box.checked = !box.checked;
  });
});

const tbody = document.querySelector('#results-table tbody');
tbody.addEventListener('change', (ev) => {
  if (ev.target.matches('input[type="checkbox"]')) {
    updateDownloadVisibility();
  }
});

const searchForm = document.getElementById('search-form');
const queryInput = document.getElementById('search-query');
const clearQueryBtn = document.getElementById('clear-query');
const sourceSelect = searchForm.querySelector('select[name="source"]');

function applyDefaultSource() {
  if (state.appPrefs.defaultSource && sourceSelect) {
    sourceSelect.value = state.appPrefs.defaultSource;
  }
}

applyDefaultSource();

function toggleClearButton() {
  clearQueryBtn.hidden = !queryInput.value;
}

queryInput.addEventListener('input', toggleClearButton);
clearQueryBtn.addEventListener('click', () => {
  queryInput.value = '';
  toggleClearButton();
  queryInput.focus();
});
toggleClearButton();

searchForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const formData = new FormData(searchForm);
  const payload = Object.fromEntries(formData.entries());
  payload.limit = Number(payload.limit || 25);
  state.lastQuery = payload.query;
  state.hasSearched = true;
  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  state.results = data.results || [];
  renderResults(state.results);
  toast(`Loaded ${state.results.length} results`);
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
    <div class="stack action-row">
      <button class="btn ghost" data-action="retry" data-id="${item.job_id}">Retry</button>
      <button class="btn ghost" data-action="save" data-id="${item.job_id}">Save for later</button>
      <button class="btn danger" data-action="abort" data-id="${item.job_id}">Abort</button>
    </div>
  `;
  return div;
}

function renderQueue(queue) {
  state.queue = queue || state.queue;
  const list = document.getElementById('queue-list');
  list.innerHTML = '';
  state.queue.forEach((item) => {
    list.appendChild(buildQueueRow(item));
  });
  document.getElementById('view-queue').hidden = state.queue.length === 0;
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
  select.value = state.appPrefs.defaultSource || 'qobuz';
  sec.appendChild(createSettingRow('Default search source', select));
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
  renderQueue(data.queue);
  resultsPanel.classList.add('hidden');
  queuePanel.classList.remove('hidden');
});

backToResultsBtn.addEventListener('click', () => {
  queuePanel.classList.add('hidden');
  resultsPanel.classList.remove('hidden');
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

document.getElementById('save-app-settings').addEventListener('click', () => {
  document.querySelectorAll('[data-app]').forEach((input) => {
    if (input.name === 'defaultSource') {
      state.appPrefs.defaultSource = input.value;
    }
  });
  saveAppPrefs(state.appPrefs);
  applyDefaultSource();
  toast('App settings saved');
});

function connectSSE() {
  const status = document.getElementById('sse-status');
  const source = new EventSource('/events/downloads');

  source.addEventListener('queue', (event) => {
    const data = JSON.parse(event.data);
    renderQueue(data);
    const ids = new Set(data.map((item) => item.job_id));
    Object.keys(state.progress).forEach((jobId) => {
      if (!ids.has(jobId)) delete state.progress[jobId];
    });
  });

  source.addEventListener('progress', (event) => {
    const data = JSON.parse(event.data);
    state.progress[data.job_id] = { overall: data.overall, track: data.track, progress: data.progress };
    state.queue = state.queue.map((item) => (item.job_id === data.job_id ? { ...item, status: item.status === 'completed' ? item.status : 'in_progress' } : item));
    renderQueue(state.queue);
  });

  source.addEventListener('saved', (event) => {
    const data = JSON.parse(event.data);
    renderSaved(data);
  });

  source.onerror = () => {
    status.classList.add('error');
    status.textContent = 'Live updates disconnected';
    toast('SSE connection lost', 'error');
  };

  source.onopen = () => {
    status.classList.remove('error');
    status.textContent = 'Live updates connected';
  };
}

connectSSE();
