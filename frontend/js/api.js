/* api.js — thin wrappers around the backend REST API. */

async function json(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  // Config
  getConfig: () => fetch('/api/config').then(json),
  setConfig: (body) =>
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json),

  // Library
  getLibrary: () => fetch('/api/library').then(json),
  videoUrl: (path) => `/api/video?path=${encodeURIComponent(path)}`,
  thumbUrl: (path) => `/api/thumb?path=${encodeURIComponent(path)}`,
  genThumbUrl: (path) => `/api/genthumb?path=${encodeURIComponent(path)}`,
  subtitleUrl: (path) => `/api/subtitle?path=${encodeURIComponent(path)}`,

  // Notes
  getNotes: () => fetch('/api/notes').then(json),
  saveNote: (path, text) =>
    fetch('/api/notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, text }),
    }).then(json),

  // Manage: rename / delete
  renameVideo: (path, title) =>
    fetch('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, title }),
    }).then(json),
  deleteVideo: (path) =>
    fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then(json),

  // Subtitle search
  searchSubtitles: (q) => fetch(`/api/subtitle_search?q=${encodeURIComponent(q)}`).then(json),
  searchSubtitleInVideo: (path, q) =>
    fetch(`/api/subtitle_search_in_video?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`).then(json),

  // Local subtitle generation (Whisper)
  transcribeAvailable: () => fetch('/api/transcribe/available').then(json),
  startTranscribe: (path, language, model, translate, modelPath) =>
    fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, language, model, translate, model_path: modelPath || '' }),
    }).then(json),
  getTranscribeJobs: () => fetch('/api/transcribe/jobs').then(json),
  getTranscribeStatus: (jobId) => fetch(`/api/transcribe/${jobId}`).then(json),
  cancelTranscribe: (jobId) => fetch(`/api/transcribe/${jobId}/cancel`, { method: 'POST' }).then(json),

  // Downloads
  startDownload: (url, quality, category, subtitles) =>
    fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality, category, subtitles }),
    }).then(json),
  getDownloads: () => fetch('/api/downloads').then(json),
  cancelDownload: (id) => fetch(`/api/downloads/${id}/cancel`, { method: 'POST' }).then(json),

  // Watch progress
  getProgress: () => fetch('/api/watch').then(json),
  saveProgress: (path, position, duration) =>
    fetch('/api/watch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, position, duration }),
    }).then(json),
  setWatched: (path, watched) =>
    fetch('/api/watch/flag', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, watched }),
    }).then(json),
};
