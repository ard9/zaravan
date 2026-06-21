"""
downloader.py
-------------
Wraps the `yt-dlp` command line so the UI can kick off downloads and watch
their progress.

Each download (a single video OR an entire channel/playlist URL) becomes a
"job" with live progress parsed from yt-dlp's stdout. Jobs run in background
threads; the API polls `list_jobs()` / `get_job()` for status.

The yt-dlp command mirrors the user's reference command:

    yt-dlp -f "bv*[height<=720]+ba/b[height<=720]" \
           --merge-output-format mp4 \
           --download-archive "<lib>/downloaded.txt" \
           -P "<lib>" \
           -o "%(uploader)s/%(title)s.%(ext)s" \
           --no-overwrites --continue <url>

plus `--write-info-json` and `--write-thumbnail` so the library scanner gets
channel metadata and thumbnails automatically.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
import uuid
from datetime import datetime
from pathlib import Path

from config import load_config

log = logging.getLogger("mytube.downloader")

# In-memory job registry. (Downloads are ephemeral; restart = fresh list.)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()

# Quality presets -> yt-dlp -f format string.
QUALITY_FORMATS = {
    "2160": "bv*[height<=2160]+ba/b[height<=2160]",
    "1080": "bv*[height<=1080]+ba/b[height<=1080]",
    "720":  "bv*[height<=720]+ba/b[height<=720]",
    "480":  "bv*[height<=480]+ba/b[height<=480]",
    "audio": "ba/b",  # audio only
}

# Regexes for parsing yt-dlp --newline output.
RE_PERCENT = re.compile(r"\[download\]\s+([\d.]+)%")
RE_SPEED = re.compile(r"at\s+([\d.]+\s*[KMG]?i?B/s)")
RE_ETA = re.compile(r"ETA\s+([\d:]+)")
RE_ITEM = re.compile(r"Downloading item\s+(\d+)\s+of\s+(\d+)")
RE_DEST = re.compile(r"\[download\]\s+Destination:\s+(.+)")
RE_MERGE = re.compile(r"\[Merger\]\s+Merging formats into\s+\"?(.+?)\"?$")
RE_ALREADY = re.compile(r"has already been (?:downloaded|recorded)")


def _sanitize_category(category: str) -> str:
    """Make a category safe to use as a folder name (no separators/illegal chars)."""
    cat = (category or "").strip()
    cat = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "", cat).strip().strip(".")
    return cat[:60]


def _new_job(url: str, quality: str, category: str, subtitles: str = "") -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "url": url,
        "quality": quality,
        "category": category,
        "subtitles": subtitles,
        "status": "queued",          # queued | running | done | error | cancelled
        "percent": 0.0,              # current item %
        "item": 0,                   # current item index in a playlist
        "total": 0,                  # total items in playlist (0 = unknown/single)
        "current_title": "",
        "speed": "",
        "eta": "",
        "completed": 0,              # finished files
        "error": "",
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "finished_at": None,
        "log": [],                   # last lines of output (for debugging)
    }


def build_command(
    url: str, quality: str, library: Path, archive: Path,
    category: str = "", subtitles: str = "",
) -> list[str]:
    """
    Assemble the yt-dlp argument list for a job.

    `subtitles` controls caption download:
      ""       -> no subtitles
      "all"    -> every available language (manual subs preferred, falls
                  back to YouTube's auto-generated captions)
      "en,fa"  -> comma-separated language codes (manual + auto, that order)
    """
    cfg = load_config()
    fmt = QUALITY_FORMATS.get(quality, QUALITY_FORMATS["720"])

    # Output template: <Category>/<Channel>/<Title>.<ext>, or just
    # <Channel>/<Title>.<ext> when no category is given.
    cat = _sanitize_category(category)
    out_tmpl = (f"{cat}/" if cat else "") + "%(uploader)s/%(title)s.%(ext)s"

    cmd = [
        cfg["ytdlp_bin"],
        "-f", fmt,
        "-P", str(library),
        "-o", out_tmpl,
        "--download-archive", str(archive),
        "--no-overwrites",
        "--continue",
        "--write-info-json",       # gives the library scanner channel metadata
        "--write-thumbnail",       # real thumbnails for the grid
        "--convert-thumbnails", "jpg",
        "--no-mtime",
        "--newline",               # one progress line at a time (parseable)
        "--ignore-errors",         # skip a bad video instead of aborting a whole channel
    ]
    if quality == "audio":
        cmd += ["--extract-audio", "--audio-format", "mp3"]
    else:
        cmd += ["--merge-output-format", "mp4"]

    subtitles = (subtitles or "").strip()
    if subtitles:
        langs = "all" if subtitles == "all" else subtitles
        cmd += [
            "--write-subs",         # manually-created subtitles, if the uploader added any
            "--write-auto-subs",    # fall back to YouTube's auto-generated captions
            "--sub-langs", langs,
            "--convert-subs", "srt",   # normalize vtt/ass/etc to srt (matches our player)
        ]

    cmd.append(url)
    return cmd



def _run(job: dict) -> None:
    """Thread target: run yt-dlp and stream-parse its progress into `job`."""
    cfg = load_config()
    library = Path(cfg["library_path"]).expanduser()
    library.mkdir(parents=True, exist_ok=True)
    archive = library / "downloaded.txt"

    cmd = build_command(
        job["url"], job["quality"], library, archive,
        job.get("category", ""), job.get("subtitles", ""),
    )
    log.info("Job %s starting: %s", job["id"], " ".join(cmd))

    with _lock:
        job["status"] = "running"

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        with _lock:
            job["status"] = "error"
            job["error"] = (
                f"'{cfg['ytdlp_bin']}' not found. Install yt-dlp and make sure "
                "it is on your PATH (or set the binary path in Settings)."
            )
            job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        return

    job["_proc"] = proc
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip("\n")
        if not line:
            continue
        _parse_line(job, line)

    proc.wait()
    with _lock:
        job.pop("_proc", None)
        job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        if job["status"] != "cancelled":
            if proc.returncode == 0:
                job["status"] = "done"
                job["percent"] = 100.0
            else:
                # ignore-errors can still return non-zero on partial failures
                job["status"] = "done" if job["completed"] else "error"
                if job["status"] == "error" and not job["error"]:
                    job["error"] = f"yt-dlp exited with code {proc.returncode}"
    log.info("Job %s finished: %s (%s files)", job["id"], job["status"], job["completed"])


def _parse_line(job: dict, line: str) -> None:
    """Update job state from a single yt-dlp output line."""
    with _lock:
        # Keep a rolling tail of the log for debugging.
        job["log"].append(line)
        if len(job["log"]) > 200:
            job["log"] = job["log"][-200:]

        m = RE_ITEM.search(line)
        if m:
            job["item"] = int(m.group(1))
            job["total"] = int(m.group(2))

        m = RE_DEST.search(line)
        if m:
            job["current_title"] = Path(m.group(1)).stem
            job["percent"] = 0.0

        m = RE_MERGE.search(line)
        if m:
            job["current_title"] = Path(m.group(1)).stem

        m = RE_PERCENT.search(line)
        if m:
            job["percent"] = float(m.group(1))

        ms = RE_SPEED.search(line)
        job["speed"] = ms.group(1) if ms else job["speed"]

        me = RE_ETA.search(line)
        job["eta"] = me.group(1) if me else ""

        if RE_ALREADY.search(line) or "Deleting original file" in line or (
            "100%" in line and "[download]" in line
        ):
            # A file finished (downloaded fresh or already in archive).
            if "has already been" in line or "100%" in line:
                job["completed"] += 1


def start_download(url: str, quality: str, category: str = "", subtitles: str = "") -> dict:
    """Create a job and launch it in a background thread; return the job."""
    job = _new_job(url, quality, category, subtitles)
    with _lock:
        _jobs[job["id"]] = job
    threading.Thread(target=_run, args=(job,), daemon=True).start()
    return public_view(job)


def cancel_job(job_id: str) -> bool:
    with _lock:
        job = _jobs.get(job_id)
        if not job or job["status"] not in ("running", "queued"):
            return False
        proc = job.get("_proc")
        job["status"] = "cancelled"
    if proc:
        proc.terminate()
    return True


def public_view(job: dict) -> dict:
    """Strip internal fields (like the Popen handle) before sending to client."""
    return {k: v for k, v in job.items() if not k.startswith("_")}


def list_jobs() -> list[dict]:
    with _lock:
        jobs = list(_jobs.values())
    jobs.sort(key=lambda j: j["started_at"], reverse=True)
    return [public_view(j) for j in jobs]


def get_job(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
    return public_view(job) if job else None
