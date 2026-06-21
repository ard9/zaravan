/* ui.js — all DOM rendering (sidebar, grid, watch page). */

import { api } from './api.js';
import {
  state, avatarColor, initial, fmtDuration, fmtTimestamp, fmtDate, esc,
  hasNote, filteredVideos, progressOf, isWatched,
} from './state.js';

const $ = (id) => document.getElementById(id);

/* ============================================================
   Thumbnails (server ffmpeg -> browser frame grab fallback)
   ============================================================ */
function durationBadge(video) {
  return video.duration ? `<span class="duration">${fmtDuration(video.duration)}</span>` : '';
}

function overlays(video) {
  const p = progressOf(video);
  let html = '';
  if (p.watched) html += '<span class="watched-badge">WATCHED</span>';
  if (p.percent > 1) html += `<div class="watch-bar"><i style="width:${p.percent}%"></i></div>`;
  return html;
}

// Inner HTML for a .thumb / .un-thumb container.
function thumbInner(video) {
  const base = video.thumb
    ? `<img loading="lazy" src="${api.thumbUrl(video.thumb)}" alt="">`
    : `<div class="placeholder" data-thumb-for="${esc(video.path)}">&#9654;</div>`;
  return base + durationBadge(video) + overlays(video);
}

const thumbCache = {};
let thumbChain = Promise.resolve();

export function processThumbnails() {
  document.querySelectorAll('.placeholder[data-thumb-for]').forEach((ph) => {
    if (ph.dataset.queued) return;
    ph.dataset.queued = '1';
    const path = ph.getAttribute('data-thumb-for');
    thumbChain = thumbChain.then(() => fillPlaceholder(ph, path));
  });
}

async function fillPlaceholder(ph, path) {
  if (!ph.isConnected) return;
  let data = thumbCache[path];
  if (data === undefined) {
    data = await serverThumb(api.genThumbUrl(path));   // ffmpeg (fast, cached)
    if (!data) {
      try { data = await frameFromUrl(api.videoUrl(path)); }  // browser fallback
      catch { data = null; }
    }
    thumbCache[path] = data;
  }
  if (data && ph.isConnected) {
    const img = document.createElement('img');
    img.src = data;
    ph.replaceWith(img);
  }
}

function serverThumb(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? url : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function frameFromUrl(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.src = url;
    let done = false;
    const finish = (data) => { if (!done) { done = true; v.removeAttribute('src'); v.load?.(); resolve(data); } };
    v.addEventListener('loadeddata', () => {
      try { v.currentTime = Math.min((v.duration || 10) * 0.2, 8); } catch { finish(null); }
    });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 180;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL('image/jpeg', 0.7));
      } catch { finish(null); }
    });
    v.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 8000);
  });
}

/* ============================================================
   Sidebar (categories -> channels)
   ============================================================ */
export function renderSidebar() {
  const box = $('channelList');
  box.innerHTML = '';

  state.categories.forEach((cat) => {
    const catEl = document.createElement('div');
    catEl.className = 'cat-group';

    const head = document.createElement('div');
    head.className = 'cat-head' + (state.view.category === cat.name && !state.view.channel ? ' active' : '');
    head.innerHTML = `
      <span class="cat-name">${esc(cat.name)}</span>
      <span class="cat-count">${cat.count}</span>`;
    head.onclick = () => window.MyTube.selectCategory(cat.name);
    catEl.appendChild(head);

    cat.channels.forEach((ch) => {
      const chEl = document.createElement('div');
      const active = state.view.channel === ch.name && state.view.category === cat.name;
      chEl.className = 'channel-item' + (active ? ' active' : '');
      chEl.innerHTML = `
        <div class="av" style="background:${avatarColor(ch.name)}">${esc(initial(ch.name))}</div>
        <div class="nm">${esc(ch.name)}</div>
        <div class="ct">${ch.count}</div>`;
      chEl.onclick = () => window.MyTube.selectChannel(cat.name, ch.name);
      catEl.appendChild(chEl);
    });

    box.appendChild(catEl);
  });

  $('folderName').textContent = state.config.library_path ? '📁 ' + state.config.library_path : '';
}

/* ============================================================
   Grid
   ============================================================ */
export function renderGrid() {
  const grid = $('grid');
  const list = filteredVideos();

  let title = 'All videos';
  if (state.view.channel) title = state.view.channel;
  else if (state.view.category) title = state.view.category;
  else if (state.filter === 'notes') title = 'Videos with notes';
  else if (state.filter === 'unwatched') title = 'Unwatched';
  else if (state.filter === 'inprogress') title = 'Continue watching';
  if (state.subSearch && state.search.trim()) title = `Caption matches for "${state.search.trim()}"`;
  $('browseTitle').textContent = title;
  $('browseCount').textContent = list.length ? `${list.length} videos` : '';

  if (state.allVideos.length === 0) { grid.innerHTML = emptyLibraryMarkup(); return; }
  if (list.length === 0) {
    const subMsg = state.subSearch
      ? '<p>No captions matched that phrase. Try a different word, or turn off caption search (CC).</p>'
      : '<p>Try a different search, category, or filter.</p>';
    grid.innerHTML = `<div class="empty small"><div class="big">&#128269;</div>
      <h2>No matches</h2>${subMsg}</div>`;
    return;
  }

  grid.innerHTML = '';
  list.forEach((v) => grid.appendChild(card(v)));
  processThumbnails();
}

function highlightMatch(text, q) {
  if (!q) return esc(text);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return esc(text);
  const before = esc(text.slice(0, idx));
  const hit = esc(text.slice(idx, idx + q.length));
  const after = esc(text.slice(idx + q.length));
  return `${before}<mark>${hit}</mark>${after}`;
}

function subMatchSnippet(v) {
  if (!state.subSearch) return '';
  const hits = state.subResults[v.path];
  if (!hits || !hits.length) return '';
  const q = state.search.trim();
  const first = hits[0];
  return `<span class="sub-match"><span class="ts">${fmtTimestamp(first.time)}</span>${highlightMatch(first.text, q)}</span>`;
}

/* ----- "Find in this video" results (search within one video's own subtitle) ----- */
export function renderFindResults(matches, query) {
  const el = $('findResults');
  $('findClear').hidden = !query;

  if (!query) { el.innerHTML = ''; return; }

  if (!matches.length) {
    el.innerHTML = `<div class="find-empty">No matches for "${esc(query)}" in this video.</div>`;
    return;
  }

  const rows = matches.map((m) => `
    <div class="find-hit" data-time="${m.time}">
      <span class="ts">${fmtTimestamp(m.time)}</span>
      <span class="txt">${highlightMatch(m.text, query)}</span>
    </div>`).join('');
  const count = `<div class="find-count">${matches.length} match${matches.length === 1 ? '' : 'es'}</div>`;
  el.innerHTML = rows + count;

  el.querySelectorAll('.find-hit').forEach((row) => {
    row.onclick = () => {
      const t = Number(row.dataset.time);
      const player = $('player');
      if (player.readyState > 0) {
        player.currentTime = Math.max(0, t - 1);
        player.play();
      } else {
        // Player hasn't loaded metadata yet (e.g. clicked immediately after
        // opening the video) — reload it targeting this timestamp via the
        // same media-fragment technique used for cross-library search hits,
        // so only the relevant byte range is fetched.
        player.src = `${api.videoUrl(state.current.path)}#t=${Math.max(0, t - 1)}`;
        player.load();
        player.play();
      }
    };
  });
}

function card(v) {
  const el = document.createElement('div');
  el.className = 'card' + (isWatched(v) ? ' watched' : '');
  el.innerHTML = `
    <div class="thumb">${thumbInner(v)}</div>
    <div class="info">
      <div class="avatar" style="background:${avatarColor(v.uploader)}">${esc(initial(v.uploader))}</div>
      <div class="text">
        <div class="title">${esc(v.title)}</div>
        <div class="sub">
          <span class="ch">${esc(v.uploader)}</span>
          <span class="meta-line">
            ${v.category && v.category !== 'Uncategorized' ? `<span class="tag">${esc(v.category)}</span>` : ''}
            ${v.upload_date ? `<span>${fmtDate(v.upload_date)}</span>` : ''}
          </span>
          ${hasNote(v) ? '<span class="has-note">&#9636; Notes</span>' : ''}
        </div>
        ${subMatchSnippet(v)}
      </div>
    </div>`;
  el.onclick = () => {
    const hits = state.subSearch ? state.subResults[v.path] : null;
    window.MyTube.openWatch(v, hits && hits[0] ? hits[0].time : null);
  };
  return el;
}

function emptyLibraryMarkup() {
  return `<div class="empty"><div class="big">&#127916;</div>
    <h2>Your library is empty</h2>
    <p>Add a YouTube channel or video and it will download into your library, sorted by category and channel.</p>
    <button class="pill-btn accent" onclick="window.MyTube.goRoute('add')">&#43; Add channel</button>
    <p style="color:var(--text-dimmer);font-size:12px;margin-top:24px;">
      Current library: ${esc(state.config.library_path || '—')}</p></div>`;
}

export function loadingGrid() {
  $('grid').innerHTML = `<div class="empty"><div class="spinner"></div>
    <p>Scanning your library…</p></div>`;
}

/* ============================================================
   Watch page
   ============================================================ */
export async function renderWatch(video, jumpTo = null) {
  state.current = video;

  $('wTitle').textContent = video.title;
  $('wAvatar').style.background = avatarColor(video.uploader);
  $('wAvatar').textContent = initial(video.uploader);
  $('wChannel').textContent = video.uploader;
  $('wMeta').textContent = [
    video.category && video.category !== 'Uncategorized' ? video.category : null,
    video.duration ? fmtDuration(video.duration) : null,
    video.upload_date ? fmtDate(video.upload_date) : null,
    video.subtitle ? 'captions' : null,
  ].filter(Boolean).join(' • ');

  // watched toggle button label
  updateWatchedButton();

  const player = $('player');
  player.innerHTML = '';
  player.playbackRate = state.playbackRate;
  if (video.subtitle) {
    const track = document.createElement('track');
    track.kind = 'subtitles'; track.label = 'Captions'; track.srclang = 'en';
    track.src = api.subtitleUrl(video.subtitle); track.default = true;
    player.appendChild(track);
  }

  // Decide where playback should start: a subtitle-search hit takes
  // priority, otherwise resume from saved progress (unless already watched).
  const p = progressOf(video);
  let startAt = null;
  if (jumpTo !== null) {
    startAt = Math.max(0, jumpTo - 1);
  } else if (!p.watched && p.position > 5) {
    startAt = p.position;
  }

  // Using the #t=<seconds> media fragment means the *very first* network
  // request the browser makes already targets the right byte offset (via
  // an HTTP Range request), instead of fetching from the start of the file
  // and seeking afterward. This matters a lot for long videos served over
  // a real network connection — without it, every jump-to-timestamp click
  // (e.g. from a caption search result) would re-download some amount of
  // data from the beginning of the file first. preload="metadata" keeps
  // the initial request small (just enough to read duration/seek points)
  // rather than eagerly buffering video data we don't need yet.
  player.preload = 'metadata';
  player.src = startAt !== null
    ? `${api.videoUrl(video.path)}#t=${startAt}`
    : api.videoUrl(video.path);
  player.load();
  // Some browsers can reset playbackRate on src change; reapply once
  // metadata is ready (currentTime is already handled by the #t= fragment
  // above, so this only needs to re-set the rate, not seek again).
  player.onloadedmetadata = () => { player.playbackRate = state.playbackRate; };

  $('notes').value = state.notes[video.path] || '';
  updateNotesMeta();
  updateSpeedUI();
  updateAutoplayUI();
  updateGenSubsButton(video);
  updateFindBox(video);
  renderUpNext(video);
}

export function updateGenSubsButton(video) {
  const btn = $('genSubsBtn');
  if (!btn) return;
  // Only offer local generation when the video has no subtitle file yet.
  btn.hidden = !!video.subtitle;
}

export function updateFindBox(video) {
  const box = $('findBox');
  if (!box) return;
  // Only offer in-video search when this video actually has a subtitle.
  box.hidden = !video.subtitle;
  // Reset state for the new video so a stale query/results from a
  // previously watched video doesn't linger.
  $('findInput').value = '';
  $('findClear').hidden = true;
  $('findResults').innerHTML = '';
}

export function updateWatchedButton() {
  const btn = $('toggleWatched');
  if (!btn || !state.current) return;
  const watched = isWatched(state.current);
  btn.innerHTML = watched ? '&#10003; Watched' : 'Mark as watched';
  btn.classList.toggle('done', watched);
}

export function updateSpeedUI() {
  const btn = $('speedBtn');
  if (!btn) return;
  const rate = state.playbackRate;
  btn.textContent = rate === 1 ? '1x' : `${rate}x`;
  $('speedMenu').querySelectorAll('[data-speed]').forEach((el) => {
    el.classList.toggle('sel', Number(el.dataset.speed) === rate);
  });
}

export function updateAutoplayUI() {
  const stateEl = $('autoplayState');
  const btn = $('toggleAutoplay');
  if (!stateEl || !btn) return;
  stateEl.textContent = state.autoplay ? 'On' : 'Off';
  btn.classList.toggle('off', !state.autoplay);
}

export function updateNotesMeta() {
  const len = $('notes').value.trim().length;
  $('notesMeta').textContent = len ? `${len} characters` : 'no notes yet';
}

// YouTube-style: same channel first, then everything else, scrollable.
function renderUpNext(active) {
  const box = $('upnext');
  box.innerHTML = '';

  const sameChannel = state.allVideos.filter(
    (v) => v.uploader === active.uploader && v.path !== active.path
  );
  const others = state.allVideos.filter(
    (v) => v.uploader !== active.uploader && v.path !== active.path
  );
  others.sort((a, b) => (b.upload_date || '').localeCompare(a.upload_date || ''));

  const list = [...sameChannel, ...others].slice(0, 60);
  list.forEach((v) => box.appendChild(upNextRow(v)));

  if (!box.children.length) box.innerHTML = '<p class="muted">No other videos yet.</p>';
  else processThumbnails();
}

function upNextRow(v) {
  const row = document.createElement('div');
  row.className = 'upnext' + (isWatched(v) ? ' watched' : '');
  row.innerHTML = `
    <div class="un-thumb">${thumbInner(v)}</div>
    <div class="un-info">
      <div class="un-title">${esc(v.title)}</div>
      <div class="un-sub">${esc(v.uploader)}</div>
      <div class="un-sub2">
        ${v.category && v.category !== 'Uncategorized' ? `<span class="tag">${esc(v.category)}</span>` : ''}
        ${isWatched(v) ? '<span class="seen">Watched</span>' : ''}
      </div>
    </div>`;
  row.onclick = () => window.MyTube.openWatch(v);
  return row;
}

/* ============================================================
   View switching
   ============================================================ */
export function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`view-${name}`).classList.add('active');
}
