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

const DEFAULT_APP_SETTINGS = {
  defaultSource: 'qobuz',
  debugLogging: false,
  port: 8500,
};

function normalizePort(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_APP_SETTINGS.port;
}

function buildInitialAppSettings() {
  const merged = {
    ...DEFAULT_APP_SETTINGS,
    ...(window.initialAppSettings || {}),
    ...loadAppPrefs(),
  };
  return {
    ...merged,
    defaultSource: merged.defaultSource || DEFAULT_APP_SETTINGS.defaultSource,
    port: normalizePort(merged.port),
  };
}

const state = {
  results: [],
  queue: [],
  saved: window.initialSaved || [],
  config: window.initialConfig || {},
  progress: {},
  history: window.initialHistory || [],
  appSettings: buildInitialAppSettings(),
  lastQuery: '',
  hasSearched: false,
  currentSource: '',
  currentMediaType: '',
  activeTab: 'search',
  queueContext: 'search',
  activeQueueJobIds: new Set(),
  requireDownloadFolder: Boolean(window.requireDownloadFolder),
  activeSettingsTab: 'web',
  unsavedSettings: false,
};

function debugLog(...args) {
  if (state.appSettings?.debugLogging) {
    console.debug('[StreamRIP Web]', ...args);
  }
}

let queuePollTimer = null;
let queueRequestController = null;

const SETTINGS_GROUPS = {
  web: {
    label: 'StreamRIP Web',
    description: 'Configure defaults and logging for this web interface.',
    sections: ['app'],
  },
  download: {
    label: 'Download',
    description: 'Control how streamrip downloads, stores, and tags music.',
    sections: ['downloads', 'filepaths', 'database', 'conversion', 'artwork', 'metadata'],
  },
  sources: {
    label: 'Sources',
    description: 'Provider-specific quality, authentication, and filtering options.',
    sections: ['qobuz', 'qobuz_filters', 'tidal', 'deezer', 'soundcloud', 'youtube', 'lastfm'],
  },
};

const SETTINGS_SECTIONS = {
  app: {
    id: 'app',
    title: 'StreamRIP Web',
    scope: 'app',
    description: 'Local-only settings for this UI. Defaults apply to your browser and server.',
    fields: [
      {
        key: 'defaultSource',
        label: 'Default search source',
        type: 'select',
        description: 'Provider preselected when opening the search form.',
        options: [
          { value: 'qobuz', label: 'Qobuz' },
          { value: 'tidal', label: 'Tidal' },
          { value: 'deezer', label: 'Deezer' },
          { value: 'soundcloud', label: 'SoundCloud' },
        ],
      },
      {
        key: 'port',
        label: 'Web port',
        type: 'number',
        min: 1,
        step: 1,
        required: true,
        description: 'Port StreamRIP Web listens on. Requires restart to take effect.',
      },
      {
        key: 'debugLogging',
        label: 'Enable debug logging',
        type: 'checkbox',
        description: 'Write verbose logs to help troubleshoot issues.',
      },
    ],
  },
  downloads: {
    id: 'downloads',
    title: 'Downloads',
    scope: 'config',
    description: 'Folders and performance for downloads.',
    fields: [
      {
        key: 'folder',
        label: 'Download folder',
        type: 'text',
        required: true,
        placeholder: '/music/downloads',
        description: 'Folder where tracks are downloaded to.',
      },
      {
        key: 'source_subdirectories',
        label: 'Use source subfolders',
        type: 'checkbox',
        description: 'Put Qobuz albums in a "Qobuz" folder, Tidal albums in "Tidal", etc.',
      },
      {
        key: 'disc_subdirectories',
        label: 'Create disc subfolders',
        type: 'checkbox',
        description: 'Place multi-disc albums into Disc N folders.',
      },
      {
        key: 'concurrency',
        label: 'Download concurrently',
        type: 'checkbox',
        description: 'Download and convert tracks in parallel to improve speed.',
      },
      {
        key: 'max_connections',
        label: 'Max simultaneous downloads',
        type: 'number',
        min: -1,
        allowNegativeOne: true,
        description: 'Maximum tracks to download at once. Set -1 for no limit.',
      },
      {
        key: 'requests_per_minute',
        label: 'API requests per minute',
        type: 'number',
        min: -1,
        allowNegativeOne: true,
        description: 'Throttle API calls. Set -1 for no limit.',
      },
      {
        key: 'verify_ssl',
        label: 'Verify SSL certificates',
        type: 'checkbox',
        description: 'Disable only if you encounter SSL verification errors.',
      },
    ],
  },
  filepaths: {
    id: 'filepaths',
    title: 'File paths',
    scope: 'config',
    description: 'Control folder and file naming for downloads.',
    fields: [
      {
        key: 'add_singles_to_folder',
        label: 'Group singles into folders',
        type: 'checkbox',
        description: 'Create folders for single tracks using the folder format template.',
      },
      {
        key: 'folder_format',
        label: 'Folder format',
        type: 'text',
        description: 'Template for album folders. Keys: albumartist, title, year, id, bit_depth, sampling_rate, albumcomposer.',
      },
      {
        key: 'track_format',
        label: 'Track format',
        type: 'text',
        description: 'Template for track filenames. Keys: tracknumber, artist, albumartist, composer, albumcomposer, explicit.',
      },
      {
        key: 'restrict_characters',
        label: 'Restrict filenames to ASCII',
        type: 'checkbox',
        description: 'Only allow printable ASCII characters in filenames.',
      },
      {
        key: 'truncate_to',
        label: 'Max filename length',
        type: 'number',
        min: 0,
        description: 'Truncate filenames longer than this value. Some systems require a limit.',
      },
    ],
  },
  database: {
    id: 'database',
    title: 'Database',
    scope: 'config',
    description: 'Skip previously downloaded items and track failures.',
    fields: [
      {
        key: 'downloads_enabled',
        label: 'Enable downloads database',
        type: 'checkbox',
        description: 'Skip tracks already stored in the downloads database.',
      },
      {
        key: 'downloads_path',
        label: 'Downloads DB path',
        type: 'text',
        description: 'Path to the database that tracks downloaded items.',
      },
      {
        key: 'failed_downloads_enabled',
        label: 'Track failed downloads',
        type: 'checkbox',
        description: 'Log failed items for retry with `rip repair`.',
      },
      {
        key: 'failed_downloads_path',
        label: 'Failed downloads DB path',
        type: 'text',
        description: 'Path to the database that stores failed downloads.',
      },
    ],
  },
  conversion: {
    id: 'conversion',
    title: 'Conversion',
    scope: 'config',
    description: 'Transcode downloaded tracks.',
    fields: [
      {
        key: 'enabled',
        label: 'Convert after download',
        type: 'checkbox',
        description: 'Enable transcoding after download completes.',
      },
      {
        key: 'codec',
        label: 'Codec',
        type: 'select',
        valueType: 'string',
        options: [
          { value: 'FLAC', label: 'FLAC' },
          { value: 'ALAC', label: 'ALAC' },
          { value: 'OPUS', label: 'OPUS' },
          { value: 'MP3', label: 'MP3' },
          { value: 'VORBIS', label: 'VORBIS' },
          { value: 'AAC', label: 'AAC' },
        ],
        description: 'Select target codec for converted files.',
      },
      {
        key: 'sampling_rate',
        label: 'Max sampling rate (Hz)',
        type: 'number',
        min: 0,
        description: 'Tracks above this sampling rate are downsampled. 48000 recommended.',
      },
      {
        key: 'bit_depth',
        label: 'Max bit depth',
        type: 'select',
        valueType: 'number',
        options: [
          { value: 16, label: '16-bit' },
          { value: 24, label: '24-bit' },
        ],
        description: 'Applied when source bit depth exceeds this value.',
      },
      {
        key: 'lossy_bitrate',
        label: 'Lossy bitrate (kbps)',
        type: 'number',
        min: 0,
        description: 'Bitrate for lossy codecs.',
      },
    ],
  },
  artwork: {
    id: 'artwork',
    title: 'Artwork',
    scope: 'config',
    description: 'Cover art embedding and saving.',
    fields: [
      {
        key: 'embed',
        label: 'Embed artwork',
        type: 'checkbox',
        description: 'Write artwork into audio files.',
      },
      {
        key: 'embed_size',
        label: 'Embed size',
        type: 'select',
        options: [
          { value: 'thumbnail', label: 'Thumbnail' },
          { value: 'small', label: 'Small' },
          { value: 'large', label: 'Large (recommended)' },
          { value: 'original', label: 'Original' },
        ],
        description: 'Choose embedded art size. Original may be very large.',
      },
      {
        key: 'embed_max_width',
        label: 'Max embed width (px)',
        type: 'number',
        min: -1,
        allowNegativeOne: true,
        description: 'Resize embedded art to this max dimension. Use -1 for no limit.',
      },
      {
        key: 'save_artwork',
        label: 'Save artwork as file',
        type: 'checkbox',
        description: 'Export cover art as a separate JPG file.',
      },
      {
        key: 'saved_max_width',
        label: 'Max saved art width (px)',
        type: 'number',
        min: -1,
        allowNegativeOne: true,
        description: 'Resize saved art to this max dimension. Use -1 for no limit.',
      },
    ],
  },
  metadata: {
    id: 'metadata',
    title: 'Metadata',
    scope: 'config',
    description: 'Tagging rules for downloaded tracks.',
    fields: [
      {
        key: 'set_playlist_to_album',
        label: 'Use playlist name as album',
        type: 'checkbox',
        description: "Set the album tag to the playlist's name.",
      },
      {
        key: 'renumber_playlist_tracks',
        label: 'Renumber playlist tracks',
        type: 'checkbox',
        description: 'Use playlist position for track numbers instead of album position.',
      },
      {
        key: 'exclude',
        label: 'Exclude metadata tags',
        type: 'list',
        description: 'Comma or newline separated metadata tags to skip.',
      },
    ],
  },
  qobuz: {
    id: 'qobuz',
    title: 'Qobuz',
    scope: 'config',
    description: 'Quality and authentication for Qobuz.',
    fields: [
      {
        key: 'quality',
        label: 'Quality',
        type: 'select',
        valueType: 'number',
        options: [
          { value: 1, label: '320kbps MP3' },
          { value: 2, label: '16-bit / 44.1 kHz' },
          { value: 3, label: '24-bit up to 96 kHz' },
          { value: 4, label: '24-bit 96 kHz and above' },
        ],
        description: 'Preferred audio quality.',
      },
      {
        key: 'download_booklets',
        label: 'Download booklets',
        type: 'checkbox',
        description: 'Download booklet PDFs when available.',
      },
      {
        key: 'use_auth_token',
        label: 'Authenticate with token',
        type: 'checkbox',
        description: 'Use auth token instead of email/password.',
      },
      {
        key: 'email_or_userid',
        label: 'Email or user ID',
        type: 'text',
        description: 'User identifier. Use email unless using auth token.',
      },
      {
        key: 'password_or_token',
        label: 'Password or auth token',
        type: 'text',
        description: 'MD5 password hash or auth token when enabled.',
      },
      {
        key: 'app_id',
        label: 'App ID',
        type: 'text',
        description: 'Do not change unless directed.',
      },
      {
        key: 'secrets',
        label: 'Secrets',
        type: 'list',
        description: 'Authentication secrets. Leave empty unless instructed.',
      },
    ],
  },
  qobuz_filters: {
    id: 'qobuz_filters',
    title: 'Qobuz filters',
    scope: 'config',
    description: "Filter Qobuz artist discographies. Applied to other sources when possible but not guaranteed to work.",
    fields: [
      { key: 'extras', label: 'Remove extras', type: 'checkbox', description: 'Filter Collector’s Editions, live recordings, etc.' },
      { key: 'repeats', label: 'Keep highest quality repeats', type: 'checkbox', description: 'Pick highest quality when titles repeat.' },
      { key: 'non_albums', label: 'Remove EPs and singles', type: 'checkbox', description: 'Skip EPs and singles.' },
      { key: 'features', label: 'Skip non-primary artist releases', type: 'checkbox', description: 'Remove albums where the artist is not the primary artist.' },
      { key: 'non_studio_albums', label: 'Skip non-studio albums', type: 'checkbox', description: 'Exclude live and other non-studio albums.' },
      { key: 'non_remaster', label: 'Only remastered albums', type: 'checkbox', description: 'Only download remastered albums.' },
    ],
  },
  tidal: {
    id: 'tidal',
    title: 'Tidal',
    scope: 'config',
    description: 'Quality and token management for Tidal.',
    fields: [
      {
        key: 'quality',
        label: 'Quality',
        type: 'select',
        valueType: 'number',
        options: [
          { value: 0, label: '256kbps AAC' },
          { value: 1, label: '320kbps AAC' },
          { value: 2, label: 'HiFi (16/44.1 FLAC)' },
          { value: 3, label: 'MQA (24/44.1 FLAC)' },
        ],
        description: 'Preferred playback quality.',
      },
      {
        key: 'download_videos',
        label: 'Download videos when available',
        type: 'checkbox',
        description: 'Download videos included with Tidal albums.',
      },
      {
        key: 'user_id',
        label: 'User ID',
        type: 'text',
        description: 'Do not change unless reconfiguring login.',
      },
      {
        key: 'country_code',
        label: 'Country code',
        type: 'text',
        description: 'Do not change unless reconfiguring login.',
      },
      {
        key: 'access_token',
        label: 'Access token',
        type: 'text',
        description: 'Do not change unless reconfiguring login.',
      },
      {
        key: 'refresh_token',
        label: 'Refresh token',
        type: 'text',
        description: 'Do not change unless reconfiguring login.',
      },
      {
        key: 'token_expiry',
        label: 'Token expiry (Unix timestamp)',
        type: 'text',
        description: 'Unix timestamp when tokens expire. Updated after login.',
      },
    ],
  },
  deezer: {
    id: 'deezer',
    title: 'Deezer',
    scope: 'config',
    description: 'Quality and authentication for Deezer.',
    fields: [
      {
        key: 'quality',
        label: 'Quality',
        type: 'select',
        valueType: 'number',
        options: [
          { value: 0, label: 'MP3 128kbps' },
          { value: 1, label: 'MP3 320kbps' },
          { value: 2, label: 'FLAC' },
        ],
        description: 'Preferred quality for Deezer downloads.',
      },
      {
        key: 'lower_quality_if_not_available',
        label: 'Fallback to best available',
        type: 'checkbox',
        description: 'Use the best available quality when the target quality is missing.',
      },
      {
        key: 'arl',
        label: 'ARL cookie',
        type: 'text',
        description: 'Authentication cookie for your Deezer account.',
      },
      {
        key: 'use_deezloader',
        label: 'Allow deezloader',
        type: 'checkbox',
        description: 'Enable free 320kbps MP3 downloads using deezloader when no ARL is provided.',
      },
      {
        key: 'deezloader_warnings',
        label: 'Warn when falling back to deezloader',
        type: 'checkbox',
        description: 'Show warnings when using deezloader instead of the paid account.',
      },
    ],
  },
  soundcloud: {
    id: 'soundcloud',
    title: 'SoundCloud',
    scope: 'config',
    description: 'Quality and credentials for SoundCloud.',
    fields: [
      {
        key: 'quality',
        label: 'Quality',
        type: 'select',
        valueType: 'number',
        options: [{ value: 0, label: 'Default (only option)' }],
        description: 'SoundCloud currently supports only the default quality.',
      },
      {
        key: 'client_id',
        label: 'Client ID',
        type: 'text',
        description: 'Client ID used for API access.',
      },
      {
        key: 'app_version',
        label: 'App version',
        type: 'text',
        description: 'SoundCloud app version. Update when API changes.',
      },
    ],
  },
  youtube: {
    id: 'youtube',
    title: 'YouTube',
    scope: 'config',
    description: 'Audio and video download preferences for YouTube.',
    fields: [
      {
        key: 'quality',
        label: 'Quality',
        type: 'select',
        valueType: 'number',
        options: [{ value: 0, label: 'Default (only option)' }],
        description: 'Current YouTube integration supports only the default quality.',
      },
      {
        key: 'download_videos',
        label: 'Download videos',
        type: 'checkbox',
        description: 'Download accompanying video with the audio.',
      },
      {
        key: 'video_downloads_folder',
        label: 'Video download folder',
        type: 'text',
        description: 'Optional folder for downloaded videos. Defaults to download folder when empty.',
      },
    ],
  },
  lastfm: {
    id: 'lastfm',
    title: 'Last.fm',
    scope: 'config',
    description: 'Playlist search sources for Last.fm.',
    fields: [
      {
        key: 'source',
        label: 'Primary search source',
        type: 'select',
        options: [
          { value: 'qobuz', label: 'Qobuz' },
          { value: 'tidal', label: 'Tidal' },
          { value: 'deezer', label: 'Deezer' },
          { value: 'soundcloud', label: 'SoundCloud' },
        ],
        description: 'Source used when searching for playlist tracks.',
      },
      {
        key: 'fallback_source',
        label: 'Fallback search source',
        type: 'select',
        allowEmpty: true,
        options: [
          { value: '', label: 'None' },
          { value: 'qobuz', label: 'Qobuz' },
          { value: 'tidal', label: 'Tidal' },
          { value: 'deezer', label: 'Deezer' },
          { value: 'soundcloud', label: 'SoundCloud' },
        ],
        description: 'Secondary source when no results are found.',
      },
    ],
  },
};

const SETTINGS_FIELD_LOOKUP = {};
Object.values(SETTINGS_SECTIONS).forEach((section) => {
  section.fields.forEach((field) => {
    SETTINGS_FIELD_LOOKUP[`${section.id}.${field.key}`] = { ...field, sectionId: section.id, scope: section.scope };
  });
});

const tabs = document.querySelectorAll('.tab');
const savedTabButton = document.querySelector('.tab[data-tab="saved"]');
const savedTabPane = document.getElementById('tab-saved');
const savedActions = document.querySelector('.saved-actions');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const targetTab = tab.dataset.tab;
    if (state.activeTab === targetTab) return;
    if (targetTab === 'settings') {
      setActiveTab(targetTab);
      return;
    }
    guardNavigation(() => {
      setActiveTab(targetTab);
    });
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

function updateColumnVisibility() {
  const hideAll = {
    artist: false,
    tracks: false,
    year: false,
  };
  if (state.currentSource === 'deezer') {
    switch (state.currentMediaType) {
      case 'track':
        hideAll.tracks = true;
        hideAll.year = true;
        break;
      case 'artist':
        hideAll.artist = true;
        hideAll.tracks = true;
        break;
      case 'album':
        hideAll.year = true;
        break;
      case 'playlist':
        hideAll.artist = true;
        break;
      default:
        break;
    }
  }
  const map = [
    { selector: '.col-artist', hide: hideAll.artist },
    { selector: '.col-tracks', hide: hideAll.tracks },
    { selector: '.col-year', hide: hideAll.year },
  ];
  map.forEach(({ selector, hide }) => {
    document.querySelectorAll(selector).forEach((cell) => {
      cell.classList.toggle('is-hidden-col', hide);
    });
  });
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
  if (hasResults && searchLoadingBanner && !searchLoadingBanner.classList.contains('hidden')) {
    searchLoadingBanner.classList.add('hidden');
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
      <td class="col-artist">${artist}</td>
      <td class="col-title">${row.title || row.summary} ${downloadedPill}</td>
      <td class="col-year">${row.year || ''}</td>
      <td class="col-type">${row.album_type || row.media_type || ''}</td>
      <td class="col-tracks">${row.tracks || ''}</td>
      <td class="col-explicit">${row.explicit ? '⚠️' : ''}</td>
      <td class="col-source">${row.source || ''}</td>
    `;
    tbody.appendChild(tr);
  });
  updateColumnVisibility();
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
const mediaTypeSelect = searchForm.querySelector('select[name="media_type"]');
const searchLoadingBanner = document.getElementById('search-loading');
const searchLoadingText = document.getElementById('search-loading-text');
const searchSubmitBtn = searchForm.querySelector('button[type="submit"]');
const urlInput = document.getElementById('url-input');
const urlDownloadBtn = document.getElementById('url-download-btn');
const urlQueueCard = document.getElementById('url-queue-card');
const urlActions = document.querySelector('.url-actions');

function applyDefaultSource() {
  if (state.appSettings.defaultSource && sourceSelect) {
    sourceSelect.value = state.appSettings.defaultSource;
  }
  if (mediaTypeSelect) {
    state.currentMediaType = mediaTypeSelect.value;
  }
  if (sourceSelect) {
    state.currentSource = sourceSelect.value;
  }
}

applyDefaultSource();

if (sourceSelect) {
  sourceSelect.addEventListener('change', () => {
    state.currentSource = sourceSelect.value;
  });
}

if (mediaTypeSelect) {
  mediaTypeSelect.addEventListener('change', () => {
    state.currentMediaType = mediaTypeSelect.value;
  });
}

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
  state.currentSource = payload.source || sourceSelect?.value || state.currentSource;
  state.currentMediaType = payload.media_type || mediaTypeSelect?.value || state.currentMediaType;
  updateColumnVisibility();
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
  const summary = progress?.summary || {};
  const counts = summary.counts || {};
  const totalTracks = summary.total_tracks ?? Object.keys(progress?.tracks || {}).length;
  const downloadedTracks = summary.downloaded ?? counts.downloaded ?? 0;
  const skippedTracks = summary.skipped ?? counts.skipped ?? 0;
  const failedTracks = summary.failed ?? counts.failed ?? 0;
  const hasIssues = !item.downloaded && (failedTracks > 0 || skippedTracks > 0);
  const statusLabel = item.downloaded
    ? 'Completed'
    : item.status === 'failed'
      ? 'Failed'
      : item.status === 'partial' || hasIssues
        ? 'Needs attention'
        : pct
          ? `${pct}%`
          : item.status.replace('_', ' ');
  const trackProgress = progress?.progress || {};
  const trackTotal = trackProgress.total || 0;
  const trackReceived = trackProgress.received || 0;
  const trackPct = trackTotal ? Math.min(100, Math.round((trackReceived / trackTotal) * 100)) : 0;
  const trackEta = trackProgress.eta != null ? `${Math.max(0, Math.round(trackProgress.eta))}s` : '—';
  const trackLabel = progress?.track?.title || trackProgress.desc || '—';
  const trackStatus = trackProgress.status || (hasIssues ? 'Needs attention' : '—');
  const trackMessage = trackProgress.message || '';
  const trackSummary = totalTracks
    ? `${downloadedTracks}/${totalTracks} downloaded${skippedTracks ? `, ${skippedTracks} skipped` : ''}${failedTracks ? `, ${failedTracks} failed` : ''}`
    : 'Waiting for track info';
  const disableActions = item.status === 'in_progress';
  const div = document.createElement('div');
  div.className = 'queue-item';
  div.innerHTML = `
    <div class="queue-header">
      <div>
        <strong>${item.title}</strong><div class="muted">${normalizeArtist(item.artist) || ''}</div>
      </div>
      <div class="status ${item.status}">${statusLabel}</div>
    </div>
    <div class="muted">Attempts: ${item.attempts || 0}${item.error ? ` · ${item.error}` : ''}${item.force_no_db ? ' · Forcing download (no DB)' : ''}</div>
    <div class="muted">Tracks: ${trackSummary}</div>
    <div class="progress-bar"><span style="width:${pct}%;"></span></div>
    <div class="muted">Overall ETA: ${eta}</div>
    <div class="muted">Track: ${trackLabel} · ${trackPct ? `${trackPct}%` : '—'} · ETA ${trackEta} · Status: ${trackStatus}${trackMessage ? ` (${trackMessage})` : ''}</div>
    <div class="progress-bar"><span style="width:${trackPct}%;"></span></div>
    <div class="stack action-row">
      <button class="btn ghost" data-action="retry" data-id="${item.job_id}" ${disableActions ? 'disabled' : ''}>Retry</button>
      <button class="btn ghost" data-action="force" data-id="${item.job_id}" ${disableActions ? 'disabled' : ''}>Force re-download</button>
      <button class="btn ghost" data-action="save" data-id="${item.job_id}">Save for later</button>
      <button class="btn danger" data-action="abort" data-id="${item.job_id}" ${disableActions ? 'disabled' : ''}>Abort</button>
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
  debugLog('Rendering queue', { queue: incomingQueue, progress: state.progress });
  if (history) {
    state.history = history;
  }
  state.queue = incomingQueue;
  const hasQueue = state.queue.length > 0;
  if (hasQueue) {
    document.getElementById('results-card')?.classList.remove('hidden');
  }
  const queueLists = document.querySelectorAll('[data-queue-list]');
  queueLists.forEach((list) => {
    list.innerHTML = '';
  });
  let resultsUpdated = false;
  state.queue.forEach((item) => {
    const progress = state.progress[item.job_id];
    const isTerminal = ['completed', 'failed', 'partial', 'aborted'].includes(item.status);
    const status = progress && !isTerminal
      ? 'in_progress'
      : item.status;
    const downloaded = item.downloaded || Boolean(progress?.summary?.all_downloaded);
    const normalizedItem = { ...item, status, downloaded };
    if (downloaded) {
      resultsUpdated = markResultDownloadedByQueueItem(normalizedItem) || resultsUpdated;
    }
    queueLists.forEach((list) => {
      list.appendChild(buildQueueRow(normalizedItem));
    });
  });
  document.getElementById('view-queue').hidden = state.queue.length === 0;
  const historyUpdated = updateResultsWithHistory();
  if (resultsUpdated || historyUpdated) {
    renderResults(state.results);
  }
  if (!hasQueue) {
    stopQueuePolling();
  } else {
    scheduleQueuePolling();
  }
  handleQueueCompletion(prevQueue);
  if (!prevQueue.length && hasQueue) {
    refreshQueue();
  }
}

function renderSaved(saved) {
  state.saved = saved;
  const list = document.getElementById('saved-list');
  list.innerHTML = '';
  if (!saved.length) {
    list.innerHTML = '<p class="muted">No saved items yet.</p>';
    savedActions?.classList.add('hidden');
    savedTabButton?.classList.add('hidden');
    savedTabButton?.classList.remove('active');
    savedTabPane?.classList.add('hidden');
    savedTabPane?.classList.remove('active');
    if (state.activeTab === 'saved') {
      const searchTab = document.querySelector('.tab[data-tab="search"]');
      searchTab?.click();
    }
    return;
  }
  savedActions?.classList.remove('hidden');
  savedTabButton?.classList.remove('hidden');
  savedTabPane?.classList.remove('hidden');
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

function parseListValue(raw) {
  return (raw || '')
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function clearFieldError(input) {
  const wrapper = input.closest('.setting-field');
  if (!wrapper) return;
  wrapper.classList.remove('has-error');
  const errorEl = wrapper.querySelector('.field-error');
  if (errorEl) errorEl.textContent = '';
}

function setFieldError(input, message) {
  const wrapper = input.closest('.setting-field');
  if (!wrapper) return;
  wrapper.classList.add('has-error');
  let errorEl = wrapper.querySelector('.field-error');
  if (!errorEl) {
    errorEl = document.createElement('div');
    errorEl.className = 'field-error';
    wrapper.appendChild(errorEl);
  }
  errorEl.textContent = message;
}

function requiresDownloadFolder() {
  return state.requireDownloadFolder && !Boolean(state.config?.downloads?.folder);
}

function updateDownloadFolderRequirement() {
  const hasFolder = Boolean(state.config?.downloads?.folder);
  if (hasFolder) {
    state.requireDownloadFolder = false;
  }
  const downloadFolderWarning = document.getElementById('download-folder-warning');
  if (downloadFolderWarning) {
    downloadFolderWarning.classList.toggle('hidden', !requiresDownloadFolder());
  }
}

function updateSettingsSubtitle() {
  const subtitle = document.getElementById('settings-modal-subtitle');
  if (!subtitle) return;
  const messages = [];
  if (state.unsavedSettings) messages.push('Unsaved changes');
  if (requiresDownloadFolder()) messages.push('Download folder required');
  subtitle.textContent = messages.length
    ? messages.join(' · ')
    : 'Guided configuration with validation and defaults.';
}

function markSettingsDirty() {
  state.unsavedSettings = true;
  updateSettingsSubtitle();
  const saveBtn = document.getElementById('save-settings');
  const discardBtn = document.getElementById('discard-settings');
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.classList.remove('hidden');
  }
  if (discardBtn) discardBtn.classList.remove('hidden');
}

function getFieldDisplayValue(section, field) {
  const currentValues = field.scope === 'app' ? state.appSettings : state.config?.[section.id];
  const rawValue = currentValues ? currentValues[field.key] : undefined;
  if (Array.isArray(rawValue)) return rawValue.join('\n');
  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === null || rawValue === undefined) return '';
  return rawValue;
}

function createFieldControl(section, field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'setting-field';
  const label = document.createElement('label');
  const inputId = `setting-${section.id}-${field.key}`;
  label.htmlFor = inputId;
  label.textContent = `${field.label}${field.required ? ' *' : ''}`;
  let control;
  const value = getFieldDisplayValue(section, field);
  if (field.type === 'checkbox') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = Boolean(value);
  } else if (field.type === 'select') {
    control = document.createElement('select');
    field.options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = String(opt.value);
      option.textContent = opt.label;
      if (opt.description) option.title = opt.description;
      control.appendChild(option);
    });
    const optionValues = field.options.map((opt) => String(opt.value));
    const selectedValue = optionValues.includes(String(value)) ? String(value) : String(field.options[0]?.value ?? '');
    control.value = selectedValue;
  } else if (field.type === 'list') {
    control = document.createElement('textarea');
    control.rows = 3;
    control.value = Array.isArray(value) ? value.join('\n') : value || '';
  } else {
    control = document.createElement('input');
    control.type = field.type === 'number' ? 'number' : 'text';
    if (field.type === 'number' && field.min !== undefined) control.min = field.min;
    if (field.type === 'number' && field.max !== undefined) control.max = field.max;
    if (field.type === 'number' && field.step !== undefined) control.step = field.step;
    control.value = value ?? '';
  }
  control.id = inputId;
  control.dataset.settingsInput = 'true';
  control.dataset.section = section.id;
  control.dataset.key = field.key;
  control.dataset.scope = field.scope;
  control.dataset.fieldType = field.type;
  if (field.required) control.dataset.required = 'true';
  if (field.allowNegativeOne) control.dataset.allowNegativeOne = 'true';
  if (field.valueType) control.dataset.valueType = field.valueType;
  if (field.allowEmpty) control.dataset.allowEmpty = 'true';
  if (field.placeholder) control.placeholder = field.placeholder;
  control.autocomplete = 'off';
  control.addEventListener('input', () => {
    clearFieldError(control);
    markSettingsDirty();
  });
  control.addEventListener('change', () => {
    clearFieldError(control);
    markSettingsDirty();
  });
  const description = document.createElement('div');
  description.className = 'help-text muted';
  description.textContent = field.description || '';
  if (field.type === 'checkbox') {
    wrapper.classList.add('is-checkbox');
    const row = document.createElement('div');
    row.className = 'setting-checkbox-row';
    row.append(control, label);
    wrapper.append(row, description);
  } else {
    wrapper.append(label, control, description);
  }
  return wrapper;
}

function buildSettingsSections() {
  const panels = document.getElementById('settings-panels');
  if (!panels) return;
  panels.querySelectorAll('.settings-group').forEach((panel) => { panel.innerHTML = ''; });
  Object.entries(SETTINGS_GROUPS).forEach(([groupId, meta]) => {
    const panel = panels.querySelector(`[data-settings-panel="${groupId}"]`);
    if (!panel) return;
    const intro = document.createElement('div');
    intro.className = 'settings-group-intro';
    intro.innerHTML = `<p class="muted">${meta.description}</p>`;
    panel.appendChild(intro);
    meta.sections.forEach((sectionId) => {
      const section = SETTINGS_SECTIONS[sectionId];
      if (!section) return;
      const card = document.createElement('div');
      card.className = 'settings-card';
      const header = document.createElement('div');
      header.className = 'settings-card-header';
      header.innerHTML = `<div><h3>${section.title}</h3><p class="muted">${section.description}</p></div>`;
      const fields = document.createElement('div');
      fields.className = 'settings-fields';
      section.fields.forEach((field) => {
        fields.appendChild(createFieldControl(section, field));
      });
      card.append(header, fields);
      panel.appendChild(card);
    });
  });
}

function setActiveSettingsTab(tabId) {
  state.activeSettingsTab = tabId;
  const tabButtons = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-group');
  tabButtons.forEach((btn) => {
    const isActive = btn.dataset.settingsTab === tabId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.setAttribute('tabindex', isActive ? '0' : '-1');
  });
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.settingsPanel !== tabId);
  });
}

function canProceedFromSettings() {
  if (requiresDownloadFolder()) {
    toast('Set a download folder in the Download group before leaving settings.', 'error');
    setActiveTab('settings');
    setActiveSettingsTab('download');
    return false;
  }
  return true;
}

function collectSettingsData() {
  const configPayload = {};
  const appPayload = {};
  const errors = [];
  document.querySelectorAll('[data-settings-input="true"]').forEach((input) => {
    clearFieldError(input);
    const sectionId = input.dataset.section;
    const key = input.dataset.key;
    const lookup = SETTINGS_FIELD_LOOKUP[`${sectionId}.${key}`];
    if (!lookup) return;
    const required = input.dataset.required === 'true';
    const allowNegativeOne = input.dataset.allowNegativeOne === 'true';
    const valueType = input.dataset.valueType || lookup.valueType;
    let parsedValue;
    if (lookup.type === 'checkbox') {
      parsedValue = input.checked;
    } else if (lookup.type === 'select') {
      const validValues = new Set(lookup.options.map((opt) => String(opt.value)));
      if (!validValues.has(String(input.value))) {
        errors.push(`${lookup.label} has an invalid value.`);
        setFieldError(input, 'Select one of the listed options.');
        return;
      }
      parsedValue = valueType === 'number' ? Number(input.value) : input.value;
    } else if (lookup.type === 'list') {
      parsedValue = parseListValue(input.value);
    } else if (lookup.type === 'number') {
      if (input.value === '') {
        errors.push(`${lookup.label} is required.`);
        setFieldError(input, 'This field is required.');
        return;
      }
      parsedValue = Number(input.value);
      if (!Number.isFinite(parsedValue)) {
        errors.push(`${lookup.label} must be a number.`);
        setFieldError(input, 'Enter a valid number.');
        return;
      }
      if (!allowNegativeOne && lookup.min !== undefined && parsedValue < lookup.min) {
        errors.push(`${lookup.label} must be at least ${lookup.min}.`);
        setFieldError(input, `Value must be at least ${lookup.min}.`);
        return;
      }
      if (allowNegativeOne && parsedValue < -1) {
        errors.push(`${lookup.label} must be -1 or higher.`);
        setFieldError(input, 'Use -1 for no limit or a higher value.');
        return;
      }
      if (lookup.max !== undefined && parsedValue > lookup.max) {
        errors.push(`${lookup.label} must be ${lookup.max} or below.`);
        setFieldError(input, `Value must be ${lookup.max} or below.`);
        return;
      }
    } else {
      parsedValue = input.value.trim();
    }
    if (required) {
      const isEmpty = parsedValue === '' || parsedValue === null || (Array.isArray(parsedValue) && parsedValue.length === 0);
      if (isEmpty) {
        errors.push(`${lookup.label} is required.`);
        setFieldError(input, 'This field is required.');
        return;
      }
    }
    if (lookup.allowEmpty && parsedValue === '') {
      parsedValue = '';
    }
    if (lookup.scope === 'app') {
      appPayload[key] = parsedValue;
    } else {
      configPayload[sectionId] = configPayload[sectionId] || {};
      configPayload[sectionId][key] = parsedValue;
    }
  });
  return { configPayload, appPayload, errors };
}

async function saveAllSettings(showToast = true) {
  const { configPayload, appPayload, errors } = collectSettingsData();
  if (errors.length) {
    toast(errors[0], 'error');
    return false;
  }
  if (requiresDownloadFolder()) {
    const downloadFolderInput = document.querySelector('[data-section=\"downloads\"][data-key=\"folder\"]');
    if (!downloadFolderInput || !downloadFolderInput.value.trim()) {
      toast('Please provide a download folder before saving.', 'error');
      if (downloadFolderInput) setFieldError(downloadFolderInput, 'Download folder is required.');
      setActiveSettingsTab('download');
      return false;
    }
  }
  if (Object.keys(appPayload).length) {
    const mergedApp = {
      ...state.appSettings,
      ...appPayload,
      port: normalizePort(appPayload.port ?? state.appSettings.port),
    };
    state.appSettings = mergedApp;
    saveAppPrefs(state.appSettings);
    const res = await fetch('/api/app-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.appSettings),
    });
    if (res.ok) {
      const saved = await res.json();
      state.appSettings = Object.keys(saved || {}).length
        ? { ...DEFAULT_APP_SETTINGS, ...saved, ...loadAppPrefs(), port: normalizePort(saved?.port) }
        : mergedApp;
    } else {
      state.appSettings = mergedApp;
    }
  }
  if (Object.keys(configPayload).length) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configPayload),
    });
    state.config = await res.json();
  }
  state.unsavedSettings = false;
  applyDefaultSource();
  updateDownloadFolderRequirement();
  buildSettingsSections();
  updateSettingsSubtitle();
  const saveBtn = document.getElementById('save-settings');
  const discardBtn = document.getElementById('discard-settings');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.classList.add('hidden');
  }
  if (discardBtn) discardBtn.classList.add('hidden');
  if (showToast) toast('Settings saved');
  return true;
}

function resetSettingsForms() {
  state.unsavedSettings = false;
  buildSettingsSections();
  updateSettingsSubtitle();
  const saveBtn = document.getElementById('save-settings');
  const discardBtn = document.getElementById('discard-settings');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.classList.add('hidden');
  }
  if (discardBtn) discardBtn.classList.add('hidden');
}

function requestUnsavedConfirmation(nextAction) {
  const modal = document.getElementById('unsaved-modal');
  if (!modal) {
    if (typeof nextAction === 'function') nextAction();
    return;
  }
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  requestUnsavedConfirmation.nextAction = nextAction;
  const message = document.getElementById('unsaved-modal-message');
  if (message) {
    message.textContent = 'You have unsaved changes. Save them or discard before continuing.';
  }
}

function closeUnsavedModal() {
  const modal = document.getElementById('unsaved-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

async function handleUnsavedSave() {
  const saved = await saveAllSettings();
  if (saved && typeof requestUnsavedConfirmation.nextAction === 'function') {
    if (!canProceedFromSettings()) {
      closeUnsavedModal();
      return;
    }
    requestUnsavedConfirmation.nextAction();
    requestUnsavedConfirmation.nextAction = null;
  }
  closeUnsavedModal();
}

function handleUnsavedDiscard() {
  resetSettingsForms();
  if (typeof requestUnsavedConfirmation.nextAction === 'function' && canProceedFromSettings()) {
    requestUnsavedConfirmation.nextAction();
    requestUnsavedConfirmation.nextAction = null;
  }
  closeUnsavedModal();
}

function handleUnsavedCancel() {
  requestUnsavedConfirmation.nextAction = null;
  closeUnsavedModal();
}

async function hydrateAppSettings() {
  const basePrefs = buildInitialAppSettings();
  state.appSettings = { ...basePrefs };
  try {
    const res = await fetch('/api/app-settings');
    if (res.ok) {
      const data = await res.json();
      state.appSettings = {
        ...DEFAULT_APP_SETTINGS,
        ...data,
        ...loadAppPrefs(),
        port: normalizePort(data?.port),
      };
    }
  } catch (err) {
    console.error('Failed to load app settings', err);
    state.appSettings = { ...basePrefs };
  }
  state.appSettings.port = normalizePort(state.appSettings.port);
  if (!state.appSettings.defaultSource) {
    state.appSettings.defaultSource = DEFAULT_APP_SETTINGS.defaultSource;
  }
}

async function initializeSettingsState() {
  await hydrateAppSettings();
  buildSettingsSections();
  setActiveSettingsTab(state.activeSettingsTab || 'web');
  const saveBtn = document.getElementById('save-settings');
  const discardBtn = document.getElementById('discard-settings');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.classList.add('hidden');
  }
  if (discardBtn) discardBtn.classList.add('hidden');
  updateDownloadFolderRequirement();
  updateSettingsSubtitle();
  if (requiresDownloadFolder()) {
    setActiveTab('settings');
    setActiveSettingsTab('download');
    toast('Set a download folder to continue.', 'error');
  }
}

renderResults(state.results);
renderSaved(state.saved);
initializeSettingsState();

const resultsCard = document.getElementById('results-card');
const queuePanel = document.getElementById('queue-panel');
const resultsPanel = document.getElementById('results-panel');
const backToResultsBtn = document.getElementById('back-to-results');
const viewQueueBtn = document.getElementById('view-queue');

document.getElementById('download-btn').addEventListener('click', async () => {
  const selected = Array.from(document.querySelectorAll('#results-table tbody input[type="checkbox"]:checked'))
    .map((box) => state.results[Number(box.dataset.index)]);
  if (!selected.length) return;
  const previousIds = new Set(state.queue.map((item) => item.job_id));
  const res = await fetch('/api/downloads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: selected }),
  });
  const data = await res.json();
  const newIds = (data.queue || []).map((item) => item.job_id).filter((id) => !previousIds.has(id));
  state.activeQueueJobIds = new Set(newIds);
  state.queueContext = 'search';
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

document.querySelectorAll('[data-queue-list]').forEach((queueList) => {
  queueList.addEventListener('click', async (ev) => {
    const action = ev.target.dataset.action;
    const jobId = ev.target.dataset.id;
    if (!action || !jobId) return;
    await fetch(`/api/queue/${jobId}/${action}`, { method: 'POST' });
  });
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
  state.activeQueueJobIds = new Set();
  state.queueContext = state.activeTab;
  toast('Queued all saved items');
});

async function refreshSaved() {
  const res = await fetch('/api/saved');
  const data = await res.json();
  renderSaved(data.saved || []);
}

function cancelQueueRequest() {
  if (queueRequestController) {
    queueRequestController.abort();
    queueRequestController = null;
  }
}

function isTabVisible() {
  return document.visibilityState === 'visible' && !document.hidden;
}

function shouldPollQueue() {
  const hasQueue = Array.isArray(state.queue) && state.queue.length > 0;
  return hasQueue && isTabVisible();
}

async function refreshQueue() {
  if (!shouldPollQueue()) {
    stopQueuePolling();
    return;
  }
  cancelQueueRequest();
  queueRequestController = new AbortController();
  try {
    const res = await fetch('/api/queue', { signal: queueRequestController.signal });
    const data = await res.json();
    debugLog('Queue poll response', data);
    renderQueue(data.queue || [], data.progress, data.history);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Failed to refresh queue', err);
  } finally {
    queueRequestController = null;
  }
}

function stopQueuePolling() {
  cancelQueueRequest();
  if (queuePollTimer) {
    clearTimeout(queuePollTimer);
    queuePollTimer = null;
  }
}

function scheduleQueuePolling() {
  if (queuePollTimer) {
    clearTimeout(queuePollTimer);
    queuePollTimer = null;
  }
  if (!shouldPollQueue()) {
    stopQueuePolling();
    return;
  }
  queuePollTimer = setTimeout(async () => {
    await refreshQueue();
    scheduleQueuePolling();
  }, 6000);
}

function setActiveTab(tabId) {
  tabs.forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
  const targetButton = document.querySelector(`.tab[data-tab="${tabId}"]`);
  const targetPane = document.getElementById(`tab-${tabId}`);
  targetButton?.classList.add('active');
  targetPane?.classList.add('active');
  state.activeTab = tabId;
}

function guardNavigation(action) {
  if (state.unsavedSettings) {
    requestUnsavedConfirmation(() => {
      action();
    });
    return;
  }
  if (!canProceedFromSettings()) return;
  action();
}

document.getElementById('save-settings')?.addEventListener('click', async () => {
  const saved = await saveAllSettings();
  if (saved) {
    updateSettingsSubtitle();
  }
});

document.getElementById('discard-settings')?.addEventListener('click', () => {
  if (!state.unsavedSettings) return;
  requestUnsavedConfirmation(() => {
    resetSettingsForms();
  });
});

document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.settingsTab;
    if (state.activeSettingsTab === target) return;
    if (state.unsavedSettings) {
      requestUnsavedConfirmation(() => {
        setActiveSettingsTab(target);
      });
      return;
    }
    setActiveSettingsTab(target);
  });
});

document.getElementById('unsaved-save')?.addEventListener('click', handleUnsavedSave);
document.getElementById('unsaved-discard')?.addEventListener('click', handleUnsavedDiscard);
document.getElementById('unsaved-cancel')?.addEventListener('click', handleUnsavedCancel);

window.addEventListener('beforeunload', (event) => {
  if (state.unsavedSettings || requiresDownloadFolder()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function handleQueueCompletion(prevQueue) {
  const queueMap = new Map(state.queue.map((item) => [item.job_id, item]));
  const activeJobs = Array.from(state.activeQueueJobIds || []);
  const activeItems = activeJobs
    .map((id) => queueMap.get(id))
    .filter(Boolean);
  const activeHasFailure = activeItems.some(
    (item) => ['failed', 'aborted', 'retrying'].includes(item.status) || !item.downloaded,
  );
  const activeAllDone = activeItems.length > 0 && activeItems.every((item) => item.downloaded);

  if (state.queueContext === 'url') {
    if (state.queue.length && activeJobs.length) {
      urlQueueCard?.classList.remove('hidden');
    }
    if (activeAllDone && !activeHasFailure) {
      toast('All URL downloads completed successfully');
      if (urlInput) {
        urlInput.value = '';
      }
      if (urlDownloadBtn) {
        urlDownloadBtn.disabled = true;
      }
      toggleUrlButton();
      urlQueueCard?.classList.add('hidden');
      state.activeQueueJobIds = new Set();
    }
    return;
  }

  if (state.queueContext === 'search' && prevQueue.length > 0 && activeJobs.length > 0) {
    const resultsPanelEl = document.getElementById('results-panel');
    const queuePanelEl = document.getElementById('queue-panel');
    if (activeAllDone && !activeHasFailure) {
      queuePanelEl?.classList.add('hidden');
      resultsPanelEl?.classList.remove('hidden');
      renderResults(state.results);
      toast('All downloads completed successfully');
      state.activeQueueJobIds = new Set();
    }
  }
}

function toggleUrlButton() {
  if (!urlInput || !urlDownloadBtn) return;
  const lines = (urlInput.value || '').split('\n').map((v) => v.trim()).filter(Boolean);
  const hasUrls = lines.length > 0;
  urlDownloadBtn.disabled = !hasUrls;
  urlDownloadBtn.classList.toggle('hidden', !hasUrls);
  urlActions?.classList.toggle('hidden', !hasUrls);
}

if (urlInput) {
  urlInput.addEventListener('input', toggleUrlButton);
}

if (urlDownloadBtn && urlInput) {
  urlDownloadBtn.addEventListener('click', async () => {
    const urls = (urlInput.value || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!urls.length) return;
    const previousIds = new Set(state.queue.map((item) => item.job_id));
    const res = await fetch('/api/url-downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    if (!res.ok) {
      toast('Failed to queue URLs. Please check the links.', 'error');
      return;
    }
    const data = await res.json();
    const newIds = (data.queue || []).map((item) => item.job_id).filter((id) => !previousIds.has(id));
    state.activeQueueJobIds = new Set(newIds);
    state.queueContext = 'url';
    renderQueue(data.queue, data.progress, data.history);
    urlQueueCard?.classList.remove('hidden');
  });
}

function connectSSE() {
  const status = document.getElementById('sse-status');
  const source = new EventSource('/events/downloads');

  source.addEventListener('queue', (event) => {
    const payload = JSON.parse(event.data);
    const data = payload.data || payload.queue || payload;
    debugLog('SSE queue event', data);
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
    debugLog('SSE progress event', data);
    state.progress[data.job_id] = data;
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
scheduleQueuePolling();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopQueuePolling();
    return;
  }
  refreshQueue();
  scheduleQueuePolling();
});
toggleUrlButton();
