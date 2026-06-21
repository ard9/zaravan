/* app.js — entrypoint: loads data, wires events, handles routing + progress. */

import { api } from './api.js';
import { state, isWatched } from './state.js';
import * as ui from './ui.js';
import * as dl from './download.js';

const $ = (id) => document.getElementById(id);

window.MyTube = {
  goRoute,
  selectCategory,
  selectChannel,
  openWatch,
  reloadLibrary: loadLibrary,
};

/* ---------- routing ---------- */
function goRoute(name) {
  $('player').pause();
  closeSubgenBox();
  clearTimeout(findTimer);
  if (name === 'home') {
    state.view = { category: null, channel: null };
    state.filter = 'all';
    setActiveNav({ route: 'home' });
    syncFilterChips();
    ui.showView('browse');
    ui.renderSidebar();
    ui.renderGrid();
  } else if (name === 'add') {
    setActiveNav({ route: 'add' });
    ui.showView('add');
    dl.updateCommandPreview();
  } else if (name === 'downloads') {
    setActiveNav({ route: 'downloads' });
    ui.showView('downloads');
    dl.refreshJobs();
  } else if (name === 'settings') {
    setActiveNav({ route: 'settings' });
    $('setLibrary').value = state.config.library_path || '';
    $('setBin').value = state.config.ytdlp_bin || '';
    ui.showView('settings');
  }
}

function selectCategory(name) {
  state.view = { category: name, channel: null };
  state.filter = 'all';
  setActiveNav({});
  syncFilterChips();
  ui.showView('browse');
  ui.renderSidebar();
  ui.renderGrid();
}

function selectChannel(category, channel) {
  state.view = { category, channel };
  state.filter = 'all';
  setActiveNav({});
  syncFilterChips();
  ui.showView('browse');
  ui.renderSidebar();
  ui.renderGrid();
}

function setFilter(filter) {
  state.filter = filter;
  state.view = { category: null, channel: null };
  setActiveNav(filter === 'notes' ? { filter: 'notes' } : { route: 'home' });
  syncFilterChips();
  ui.showView('browse');
  ui.renderSidebar();
  ui.renderGrid();
}

async function openWatch(video, jumpTo = null) {
  ui.showView('watch');
  window.scrollTo(0, 0);
  await ui.renderWatch(video, jumpTo);
  attachProgressTracking();
  attachAutoplayOnEnd();
}

function setActiveNav({ route, filter } = {}) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  if (route) document.querySelector(`.nav-item[data-route="${route}"]`)?.classList.add('active');
  if (filter) document.querySelector(`.nav-item[data-filter="${filter}"]`)?.classList.add('active');
}

function syncFilterChips() {
  document.querySelectorAll('.chip[data-filter]').forEach((c) =>
    c.classList.toggle('active', c.dataset.filter === state.filter)
  );
}

/* ---------- data loading ---------- */
async function loadConfig() {
  try { state.config = await api.getConfig(); } catch { state.config = {}; }
  state.quality = state.config.default_quality || '720';
}

async function loadLibrary() {
  ui.loadingGrid();
  try {
    const [lib, notes, prog] = await Promise.all([
      api.getLibrary(), api.getNotes(), api.getProgress(),
    ]);
    state.categories = lib.categories || [];
    state.allVideos = state.categories.flatMap((c) => c.channels.flatMap((ch) => ch.videos));
    state.notes = notes || {};
    state.progress = prog || {};
    state.config.library_path = lib.library_path;
  } catch (e) {
    $('grid').innerHTML = `<div class="empty"><div class="big">&#9888;</div>
      <h2>Could not reach the server</h2>
      <p>${e.message}. Make sure the backend is running.</p></div>`;
    return;
  }
  ui.renderSidebar();
  ui.renderGrid();
}

/* ---------- watch progress tracking ---------- */
let progressTimer = null;
function attachProgressTracking() {
  const player = $('player');
  clearInterval(progressTimer);

  const save = () => {
    if (!state.current || !player.duration || isNaN(player.duration)) return;
    const path = state.current.path;
    const pos = player.currentTime, dur = player.duration;
    // update local cache immediately so the UI reflects it
    const prev = state.progress[path] || {};
    state.progress[path] = {
      position: pos, duration: dur,
      watched: prev.watched || pos >= dur * 0.9,
    };
    api.saveProgress(path, pos, dur).then(() => ui.updateWatchedButton()).catch(() => {});
  };

  // periodic save while playing
  progressTimer = setInterval(() => { if (!player.paused) save(); }, 5000);
  player.onpause = save;
}

/* ---------- autoplay: advance to the next "up next" video when one ends ---------- */
function attachAutoplayOnEnd() {
  const player = $('player');
  player.onended = () => {
    if (!state.current) return;
    const path = state.current.path;
    state.progress[path] = {
      position: player.duration, duration: player.duration, watched: true,
    };
    api.setWatched(path, true).then(() => ui.updateWatchedButton()).catch(() => {});

    if (state.autoplay) {
      const next = nextUpNextVideo(state.current);
      if (next) {
        setTimeout(() => openWatch(next), 600);
      }
    }
  };
}

function nextUpNextVideo(active) {
  const sameChannel = state.allVideos.filter(
    (v) => v.uploader === active.uploader && v.path !== active.path
  );
  if (sameChannel.length) return sameChannel[0];
  const others = state.allVideos.filter((v) => v.uploader !== active.uploader);
  others.sort((a, b) => (b.upload_date || '').localeCompare(a.upload_date || ''));
  return others[0] || null;
}

async function toggleWatched() {
  if (!state.current) return;
  const path = state.current.path;
  const next = !isWatched(state.current);
  const prev = state.progress[path] || { position: 0, duration: 0 };
  state.progress[path] = { ...prev, watched: next, position: next ? prev.position : 0 };
  ui.updateWatchedButton();
  try { await api.setWatched(path, next); } catch {}
}

/* ---------- subtitle ("CC") search ---------- */
let subSearchTimer = null;
async function runSubtitleSearch() {
  const q = state.search.trim();
  if (!q) { state.subResults = {}; ui.renderGrid(); return; }
  try {
    const res = await api.searchSubtitles(q);
    const map = {};
    (res.results || []).forEach((r) => { map[r.video_path] = r.matches; });
    state.subResults = map;
  } catch {
    state.subResults = {};
  }
  ui.renderGrid();
}

/* ---------- "Find in this video" search (within the currently open video only) ---------- */
let findTimer = null;
async function runFindInVideo() {
  if (!state.current) return;
  const q = $('findInput').value.trim();
  if (!q) { ui.renderFindResults([], ''); return; }
  let matches = [];
  try {
    const res = await api.searchSubtitleInVideo(state.current.path, q);
    matches = res.matches || [];
  } catch {
    matches = [];
  }
  ui.renderFindResults(matches, q);
}

/* ---------- notes saving (debounced) ---------- */
let noteTimer;
async function saveNote() {
  if (!state.current) return;
  const text = $('notes').value;
  state.notes[state.current.path] = text;
  try { await api.saveNote(state.current.path, text); } catch {}
  flash('savedTag');
  ui.updateNotesMeta();
}
function flash(id) {
  const el = $(id);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1400);
}

/* ---------- settings ---------- */
async function saveSettings() {
  const body = { library_path: $('setLibrary').value.trim(), ytdlp_bin: $('setBin').value.trim() };
  try {
    state.config = await api.setConfig(body);
    flash('settingsSaved');
    await loadLibrary();
  } catch (e) {
    alert('Could not save settings: ' + e.message);
  }
}

/* ---------- playback speed ---------- */
function setPlaybackRate(rate) {
  state.playbackRate = rate;
  localStorage.setItem('mytube_rate', String(rate));
  $('player').playbackRate = rate;
  ui.updateSpeedUI();
  $('speedMenu').classList.remove('show');
}

/* ---------- autoplay toggle ---------- */
function toggleAutoplay() {
  state.autoplay = !state.autoplay;
  localStorage.setItem('mytube_autoplay', state.autoplay ? 'on' : 'off');
  ui.updateAutoplayUI();
}

/* ---------- rename ---------- */
function openRenameModal() {
  if (!state.current) return;
  $('renameInput').value = state.current.title;
  $('renameModal').classList.add('show');
  $('renameInput').focus();
  $('renameInput').select();
}
function closeRenameModal() {
  $('renameModal').classList.remove('show');
}
async function confirmRename() {
  if (!state.current) return;
  const title = $('renameInput').value.trim();
  if (!title) return;
  try {
    const result = await api.renameVideo(state.current.path, title);
    closeRenameModal();
    await loadLibrary();
    const updated = state.allVideos.find((v) => v.path === result.new_path);
    if (updated) openWatch(updated);
  } catch (e) {
    alert('Could not rename: ' + e.message);
  }
}

/* ---------- delete ---------- */
function openDeleteModal() {
  if (!state.current) return;
  $('deleteTarget').textContent = state.current.title;
  $('deleteModal').classList.add('show');
}
function closeDeleteModal() {
  $('deleteModal').classList.remove('show');
}
async function confirmDelete() {
  if (!state.current) return;
  try {
    await api.deleteVideo(state.current.path);
    closeDeleteModal();
    goRoute('home');
    await loadLibrary();
  } catch (e) {
    alert('Could not delete: ' + e.message);
  }
}

/* ---------- local subtitle generation (Whisper) ---------- */
let subgenPollTimer = null;
let subgenAvailability = null; // cached {available, models, default_model}

function selectedSubgenLanguage() {
  const custom = $('subgenCustomLang').value.trim();
  if (custom) return custom;
  const active = $('subgenLangRow').querySelector('.q-btn.active');
  return active ? active.dataset.lang : '';
}
function selectedSubgenModel() {
  const active = $('subgenModelRow').querySelector('.q-btn.active');
  return active ? active.dataset.model : 'small';
}
function selectedSubgenModelPath() {
  return $('subgenUseCustomPath').checked ? $('subgenCustomPath').value.trim() : '';
}

async function openSubgenBox() {
  if (!state.current) return;
  $('subgenBox').hidden = false;
  $('subgenForm').hidden = false;
  $('subgenProgress').hidden = true;
  $('subgenAvailHint').textContent = '';
  $('subgenUseCustomPath').checked = false;
  $('subgenCustomPath').hidden = true;
  $('subgenCustomPath').value = '';
  $('subgenCustomPathHint').hidden = true;

  if (!subgenAvailability) {
    try { subgenAvailability = await api.transcribeAvailable(); } catch { subgenAvailability = { available: false }; }
  }
  if (!subgenAvailability.available) {
    $('subgenAvailHint').textContent =
      "Local subtitle generation needs faster-whisper on the server. Run 'pip install faster-whisper' and restart MyTube, then try again.";
    $('subgenStart').disabled = true;
  } else {
    $('subgenStart').disabled = false;
  }
}

function closeSubgenBox() {
  $('subgenBox').hidden = true;
  clearInterval(subgenPollTimer);
  subgenPollTimer = null;
}

async function startSubgen() {
  if (!state.current) return;
  const btn = $('subgenStart');
  btn.disabled = true;
  try {
    const job = await api.startTranscribe(
      state.current.path,
      selectedSubgenLanguage(),
      selectedSubgenModel(),
      $('subgenTranslate').checked,
      selectedSubgenModelPath(),
    );
    $('subgenForm').hidden = true;
    $('subgenProgress').hidden = false;
    $('subgenFill').style.width = '0%';
    $('subgenFill').classList.add('busy');
    $('subgenStatus').textContent = 'Starting…';
    pollSubgen(job.id);
  } catch (e) {
    $('subgenAvailHint').textContent = 'Could not start: ' + e.message;
    btn.disabled = false;
  }
}

function pollSubgen(jobId) {
  clearInterval(subgenPollTimer);
  subgenPollTimer = setInterval(async () => {
    let job;
    try { job = await api.getTranscribeStatus(jobId); } catch { return; }

    const isBusyStage = job.stage === 'loading_model' || job.stage === 'analyzing' || (job.stage === 'transcribing' && !job.percent);
    $('subgenFill').classList.toggle('busy', isBusyStage);
    if (!isBusyStage) $('subgenFill').style.width = `${job.percent || 0}%`;

    const stageText = {
      queued: 'Queued…',
      loading_model: 'Loading Whisper model (first time may download it — this can take a while)…',
      analyzing: 'Reading audio…',
      transcribing: `Transcribing… ${job.percent || 0}%${job.segments_written ? ` · ${job.segments_written} lines so far` : ''}${job.detected_language ? ' · detected: ' + job.detected_language : ''}`,
      done: 'Done! Reloading…',
    }[job.stage];

    const statusText = job.status === 'error' ? 'Error: ' + (job.error || 'unknown error')
      : job.status === 'cancelled' ? 'Cancelled.'
      : (stageText || job.status);
    $('subgenStatus').textContent = statusText;

    if (job.status === 'done') {
      clearInterval(subgenPollTimer);
      subgenPollTimer = null;
      await loadLibrary();
      const updated = state.allVideos.find((v) => v.path === state.current.path);
      if (updated) {
        closeSubgenBox();
        openWatch(updated);
      }
    } else if (job.status === 'error' || job.status === 'cancelled') {
      clearInterval(subgenPollTimer);
      subgenPollTimer = null;
      $('subgenStart').disabled = false;
    }
  }, 1500);
}

async function cancelSubgenJob() {
  // Find the most recent job for the current video via the status text's job id stash.
  const jobs = await api.getTranscribeJobs().catch(() => []);
  const mine = jobs.find((j) => j.video_path === state.current?.path && (j.status === 'running' || j.status === 'queued'));
  if (mine) await api.cancelTranscribe(mine.id).catch(() => {});
  clearInterval(subgenPollTimer);
  subgenPollTimer = null;
  $('subgenStatus').textContent = 'Cancelled.';
}

/* ---------- keyboard shortcuts (active only on the watch view) ---------- */
function handleKeydown(e) {
  if (!$('view-watch').classList.contains('active')) return;
  // Don't hijack typing in notes, search, modals, etc.
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'input') return;
  if ($('renameModal').classList.contains('show') || $('deleteModal').classList.contains('show')) return;

  const player = $('player');
  switch (e.key.toLowerCase()) {
    case ' ':
    case 'k':
      e.preventDefault();
      player.paused ? player.play() : player.pause();
      break;
    case 'arrowleft':
      e.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - 5);
      break;
    case 'arrowright':
      e.preventDefault();
      player.currentTime = Math.min(player.duration || Infinity, player.currentTime + 5);
      break;
    case 'j':
      player.currentTime = Math.max(0, player.currentTime - 10);
      break;
    case 'l':
      player.currentTime = Math.min(player.duration || Infinity, player.currentTime + 10);
      break;
    case 'arrowup':
      e.preventDefault();
      player.volume = Math.min(1, player.volume + 0.1);
      break;
    case 'arrowdown':
      e.preventDefault();
      player.volume = Math.max(0, player.volume - 0.1);
      break;
    case 'm':
      player.muted = !player.muted;
      break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else player.closest('.player-shell')?.requestFullscreen?.();
      break;
  }
}

/* ---------- event wiring ---------- */
function wireEvents() {
  document.querySelectorAll('[data-route]').forEach((el) =>
    el.addEventListener('click', () => goRoute(el.dataset.route))
  );
  // sidebar / chip filters
  document.querySelectorAll('[data-filter]').forEach((el) =>
    el.addEventListener('click', () => setFilter(el.dataset.filter))
  );
  // sort dropdown
  $('sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    ui.renderGrid();
  });

  // search (debounced subtitle search; instant local filter otherwise)
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (!$('view-browse').classList.contains('active')) goRoute('home');
    if (state.subSearch) {
      clearTimeout(subSearchTimer);
      subSearchTimer = setTimeout(runSubtitleSearch, 300);
      ui.renderGrid(); // clear stale results immediately while debounce runs
    } else {
      ui.renderGrid();
    }
  });
  $('searchBtn').addEventListener('click', () => goRoute('home'));

  // "CC" toggle: search inside subtitle text instead of titles/metadata
  $('subSearchToggle').addEventListener('click', () => {
    state.subSearch = !state.subSearch;
    $('subSearchToggle').classList.toggle('active', state.subSearch);
    if (state.subSearch && state.search.trim()) runSubtitleSearch();
    else ui.renderGrid();
  });

  // notes
  $('saveNotes').addEventListener('click', saveNote);
  $('clearNotes').addEventListener('click', () => { $('notes').value = ''; saveNote(); });
  $('notes').addEventListener('input', () => {
    ui.updateNotesMeta();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 1000);
  });
  $('notes').addEventListener('blur', saveNote);

  // watched toggle
  $('toggleWatched').addEventListener('click', toggleWatched);

  // playback speed
  $('speedBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('speedMenu').classList.toggle('show');
  });
  $('speedMenu').querySelectorAll('[data-speed]').forEach((el) => {
    el.addEventListener('click', () => setPlaybackRate(Number(el.dataset.speed)));
  });
  document.addEventListener('click', () => $('speedMenu').classList.remove('show'));

  // autoplay toggle
  $('toggleAutoplay').addEventListener('click', toggleAutoplay);

  // rename
  $('renameBtn').addEventListener('click', openRenameModal);
  $('renameCancel').addEventListener('click', closeRenameModal);
  $('renameConfirm').addEventListener('click', confirmRename);
  $('renameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmRename(); });
  $('renameModal').addEventListener('click', (e) => { if (e.target.id === 'renameModal') closeRenameModal(); });

  // delete
  $('deleteBtn').addEventListener('click', openDeleteModal);
  $('deleteCancel').addEventListener('click', closeDeleteModal);
  $('deleteConfirm').addEventListener('click', confirmDelete);
  $('deleteModal').addEventListener('click', (e) => { if (e.target.id === 'deleteModal') closeDeleteModal(); });

  // find in this video (search within the currently open video's subtitle only)
  $('findInput').addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(runFindInVideo, 250);
  });
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(findTimer); runFindInVideo(); }
  });
  $('findClear').addEventListener('click', () => {
    $('findInput').value = '';
    ui.renderFindResults([], '');
    $('findInput').focus();
  });

  // local subtitle generation (Whisper)
  $('genSubsBtn').addEventListener('click', openSubgenBox);
  $('subgenClose').addEventListener('click', closeSubgenBox);
  $('subgenStart').addEventListener('click', startSubgen);
  $('subgenCancel').addEventListener('click', cancelSubgenJob);
  $('subgenLangRow').querySelectorAll('.q-btn').forEach((btn) => {
    btn.onclick = () => {
      $('subgenLangRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $('subgenCustomLang').value = '';
    };
  });
  $('subgenCustomLang').addEventListener('input', () => {
    if ($('subgenCustomLang').value.trim()) {
      $('subgenLangRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
    }
  });
  $('subgenModelRow').querySelectorAll('.q-btn').forEach((btn) => {
    btn.onclick = () => {
      $('subgenModelRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });
  $('subgenUseCustomPath').addEventListener('change', () => {
    const on = $('subgenUseCustomPath').checked;
    $('subgenCustomPath').hidden = !on;
    $('subgenCustomPathHint').hidden = !on;
    if (on) $('subgenCustomPath').focus();
  });

  // keyboard shortcuts on the watch page
  document.addEventListener('keydown', handleKeydown);

  // download panel
  dl.initButtons();
  $('dlUrl').addEventListener('input', dl.updateCommandPreview);
  $('startDownload').addEventListener('click', dl.startDownload);
  $('copyCmd').addEventListener('click', () => {
    navigator.clipboard.writeText($('cmdPreview').textContent);
    $('copyCmd').textContent = 'Copied!';
    setTimeout(() => ($('copyCmd').textContent = 'Copy command'), 1500);
  });

  // settings
  $('saveSettings').addEventListener('click', saveSettings);
}

/* ---------- boot ---------- */
async function boot() {
  wireEvents();
  await loadConfig();
  await loadLibrary();
  dl.refreshJobs();
}
boot();
