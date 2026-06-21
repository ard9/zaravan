/* download.js — the "Add channel" panel, command preview, and live job list. */

import { api } from './api.js';
import { state, esc } from './state.js';

const $ = (id) => document.getElementById(id);

const QUALITY_FORMATS = {
  '2160': 'bv*[height<=2160]+ba/b[height<=2160]',
  '1080': 'bv*[height<=1080]+ba/b[height<=1080]',
  '720': 'bv*[height<=720]+ba/b[height<=720]',
  '480': 'bv*[height<=480]+ba/b[height<=480]',
  'audio': 'ba/b',
};

let pollTimer = null;

/* ---------- selected category ---------- */
function selectedCategory() {
  const custom = $('customCategory').value.trim();
  if (custom) return custom;
  const active = $('categoryRow').querySelector('.q-btn.active');
  return active && active.dataset.cat ? active.dataset.cat : '';
}

/* ---------- selected subtitle languages ---------- */
function selectedSubtitles() {
  const custom = $('customSubLangs').value.trim();
  if (custom) return custom.replace(/\s+/g, '');
  const active = $('subLangRow').querySelector('.q-btn.active');
  return active ? active.dataset.sub : '';
}

/* ---------- command preview ---------- */
export function updateCommandPreview() {
  const url = $('dlUrl').value.trim() || '<URL>';
  const lib = state.config.library_path || '<library>';
  const q = state.quality;
  const fmt = QUALITY_FORMATS[q] || QUALITY_FORMATS['720'];
  const cat = selectedCategory();
  const out = (cat ? `${cat}\\` : '') + '%(uploader)s\\%(title)s.%(ext)s';
  const subs = selectedSubtitles();

  const lines = [
    'yt-dlp',
    `  -f "${fmt}"`,
    q === 'audio' ? '  --extract-audio --audio-format mp3' : '  --merge-output-format mp4',
    `  --download-archive "${lib}\\downloaded.txt"`,
    `  -P "${lib}"`,
    `  -o "${out}"`,
    '  --no-overwrites --continue',
    '  --write-info-json --write-thumbnail --convert-thumbnails jpg',
  ];
  if (subs) {
    lines.push(
      '  --write-subs --write-auto-subs',
      `  --sub-langs "${subs}"`,
      '  --convert-subs srt',
    );
  }
  lines.push(`  "${url}"`);
  $('cmdPreview').textContent = lines.join('\n');
}

/* ---------- quality + category + subtitle buttons ---------- */
export function initButtons() {
  $('qualityRow').querySelectorAll('.q-btn').forEach((btn) => {
    btn.onclick = () => {
      $('qualityRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.quality = btn.dataset.q;
      updateCommandPreview();
    };
  });
  $('categoryRow').querySelectorAll('.q-btn').forEach((btn) => {
    btn.onclick = () => {
      $('categoryRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $('customCategory').value = '';
      updateCommandPreview();
    };
  });
  $('customCategory').addEventListener('input', () => {
    if ($('customCategory').value.trim()) {
      $('categoryRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
    }
    updateCommandPreview();
  });

  $('subLangRow').querySelectorAll('.q-btn').forEach((btn) => {
    btn.onclick = () => {
      $('subLangRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $('customSubLangs').value = '';
      updateCommandPreview();
    };
  });
  $('customSubLangs').addEventListener('input', () => {
    if ($('customSubLangs').value.trim()) {
      $('subLangRow').querySelectorAll('.q-btn').forEach((b) => b.classList.remove('active'));
    }
    updateCommandPreview();
  });
}

/* ---------- start a download ---------- */
export async function startDownload() {
  const url = $('dlUrl').value.trim();
  if (!url) { $('dlUrl').focus(); return; }
  const btn = $('startDownload');
  btn.disabled = true;
  try {
    await api.startDownload(url, state.quality, selectedCategory(), selectedSubtitles());
    window.MyTube.goRoute('downloads');
    refreshJobs();
    startPolling();
  } catch (e) {
    alert('Could not start download: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- job list rendering + polling ---------- */
export async function refreshJobs() {
  let jobs = [];
  try { jobs = await api.getDownloads(); } catch { return; }

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const badge = $('dlBadge');
  badge.textContent = active;
  badge.hidden = active === 0;

  const list = $('jobList');
  $('jobEmpty').style.display = jobs.length ? 'none' : 'block';
  list.innerHTML = '';
  jobs.forEach((j) => list.appendChild(jobCard(j)));

  if (active === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function jobCard(j) {
  const el = document.createElement('div');
  el.className = 'job';
  const itemInfo = j.total > 1 ? `Item ${j.item} of ${j.total}` : '';
  const catTag = j.category ? `<span class="tag">${esc(j.category)}</span>` : '';
  el.innerHTML = `
    <div class="job-top">
      <div class="job-url">${catTag}${esc(j.url)}</div>
      <div class="job-status st-${j.status}">${j.status}</div>
    </div>
    <div class="job-title">${esc(j.current_title || (j.status === 'running' ? 'Starting…' : ''))}</div>
    <div class="progress-track"><div class="progress-fill" style="width:${j.percent || 0}%"></div></div>
    <div class="job-meta">
      <span>${itemInfo}</span>
      <span>${j.completed ? j.completed + ' done' : ''} ${j.speed ? '· ' + j.speed : ''} ${j.eta ? '· ETA ' + j.eta : ''}</span>
    </div>
    ${j.error ? `<div class="job-meta" style="color:#ff8a8a">${esc(j.error)}</div>` : ''}
    <div class="job-actions">
      ${j.status === 'running' ? `<button class="pill-btn ghost small" data-cancel="${j.id}">Cancel</button>` : ''}
      <button class="pill-btn ghost small" data-log="${j.id}">Log</button>
      ${j.status === 'done' ? '<button class="pill-btn ghost small" data-refresh="1">Refresh library</button>' : ''}
    </div>
    <div class="job-log" id="log-${j.id}">${esc((j.log || []).join('\n'))}</div>`;

  el.querySelector('[data-cancel]')?.addEventListener('click', async (e) => {
    await api.cancelDownload(e.target.dataset.cancel);
    refreshJobs();
  });
  el.querySelector('[data-log]')?.addEventListener('click', () => {
    $(`log-${j.id}`).classList.toggle('show');
  });
  el.querySelector('[data-refresh]')?.addEventListener('click', () => window.MyTube.reloadLibrary());
  return el;
}

export function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshJobs, 1000);
}
