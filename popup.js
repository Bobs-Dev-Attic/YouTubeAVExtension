/**
 * popup.js — YouTube AV Extension popup controller
 *
 * • Reads video/audio streams from chrome.storage.local.
 * • Renders stream cards with quality, codec, and expiry information.
 * • Provides a format selector (.mp4, .webm, .mp3, .m4a, .ogg, .avi …)
 *   with Download (saves the raw stream to disk via chrome.downloads)
 *   and Copy URL actions. Downloads save the adaptive stream as-is;
 *   combining video+audio or transcoding to MP3 still needs FFmpeg.
 * • Listens for storage changes so cards update automatically while the
 *   popup is open.
 */

'use strict';

// ---------------------------------------------------------------------------
// Format options offered per stream type
//
// IMPORTANT: selecting a format here only changes the suggested extension
// shown in the copied export label; it does NOT transcode or remux content.
// Selecting .avi / .mp3 is a rename-only convention and external conversion
// is still required for true container/codec changes.
// ---------------------------------------------------------------------------
const VIDEO_FORMATS = [
  { ext: 'mp4',  label: 'MP4  (.mp4)',              muxNeeded: false },
  { ext: 'webm', label: 'WebM (.webm)',              muxNeeded: false },
  { ext: 'avi',  label: 'AVI  (.avi) — rename only', muxNeeded: true  },
];

const AUDIO_FORMATS = [
  { ext: 'm4a',  label: 'M4A  (.m4a)',              muxNeeded: false },
  { ext: 'ogg',  label: 'OGG  (.ogg)',              muxNeeded: false },
  { ext: 'mp3',  label: 'MP3  (.mp3) — rename only', muxNeeded: true  },
  { ext: 'mp4',  label: 'MP4  (.mp4)',              muxNeeded: false },
];

// Preferred default extension based on stream container
const DEFAULT_VIDEO_EXT = { mp4: 'mp4', webm: 'webm' };
const DEFAULT_AUDIO_EXT = { m4a: 'm4a', webm: 'ogg' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a remaining-time duration in human-readable form. */
function formatExpiry(expireTs) {
  if (!expireTs) return null;
  const remainMs = expireTs - Date.now();
  if (remainMs <= 0) return { label: 'Expired', cls: 'expired' };
  const totalSec = Math.floor(remainMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let label;
  if (h > 0)       label = `${h}h ${m}m`;
  else if (m > 0)  label = `${m}m ${s}s`;
  else             label = `${s}s`;
  const cls = remainMs < 5 * 60 * 1000 ? 'warn' : 'ok';
  return { label: `Expires in ${label}`, cls };
}

/** Sanitise a string for use as part of a filename. */
function toFilenameSegment(str) {
  return (str || 'unknown').replace(/[^a-z0-9_\-]/gi, '_');
}

/** Show a short toast message. */
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// Track all active expiry-countdown timers so they can be cancelled when
// the popup re-renders (e.g. storage change) rather than relying on fragile
// DOM-detachment detection.
const activeTimers = new Set();

/** Cancel and clear all running expiry timers. */
function clearAllTimers() {
  activeTimers.forEach((id) => clearInterval(id));
  activeTimers.clear();
}

// ---------------------------------------------------------------------------
// Clipboard export
// ---------------------------------------------------------------------------

/** Build the export filename for a stream and chosen extension. */
function exportFilename(stream, ext, streamType) {
  const quality = toFilenameSegment(stream.quality);
  const codec = toFilenameSegment(stream.codec);
  return `youtube_${streamType}_${quality}_${codec}.${ext}`;
}

/**
 * Copy a stream URL to clipboard.
 */
async function copyStreamUrl(stream, ext, streamType) {
  const exportName = exportFilename(stream, ext, streamType);
  try {
    await navigator.clipboard.writeText(stream.url);
    showToast(`📋 URL copied — ${exportName}`);
  } catch (e) {
    showToast('❌ Clipboard unavailable — copy manually from DevTools.');
    console.error('[YT-AV] Clipboard copy error:', e?.message || e, 'URL:', stream.url);
  }
}

/**
 * Download a stream directly to disk via the browser's native download
 * manager. chrome.downloads.download() passes the signed URL straight to
 * the browser, so the media bytes are never loaded into extension memory.
 *
 * NOTE: this saves the raw adaptive stream as-is. A video itag yields a
 * SILENT video file (audio is a separate stream); an .mp3/.avi selection is
 * a rename only. Combining/transcoding still requires an external tool
 * such as FFmpeg.
 */
function triggerDownload(stream, ext, streamType) {
  const filename = exportFilename(stream, ext, streamType);
  chrome.downloads.download(
    { url: stream.url, filename, saveAs: false },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        showToast(`❌ Download failed: ${chrome.runtime.lastError.message}`);
      } else {
        showToast(`⬇️ Download started — ${filename}`);
        console.log('[YT-AV] Download ID:', downloadId, 'File:', filename);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Build the SVG download arrow icon (inline, no external CDN). */
function downloadIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    xmlns="http://www.w3.org/2000/svg">
    <path d="M12 4v12m0 0-4-4m4 4 4-4M4 20h16"
      stroke="currentColor" stroke-width="2.5"
      stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Render a single stream card DOM element. */
function buildStreamCard(stream, streamType) {
  const card      = document.createElement('div');
  card.className  = 'stream-card';

  // ── Top row: quality badge · codec info · expiry ──────────────────────
  const topRow = document.createElement('div');
  topRow.className = 'card-top';

  const qualityBadge     = document.createElement('span');
  qualityBadge.className = 'quality-badge';
  qualityBadge.textContent = stream.quality || '?';

  const codecInfo     = document.createElement('span');
  codecInfo.className = 'codec-info';
  codecInfo.textContent = `${stream.codec} · ${stream.container.toUpperCase()} · itag ${stream.itag}`;

  topRow.appendChild(qualityBadge);
  topRow.appendChild(codecInfo);

  const expiryInfo = formatExpiry(stream.expireTs);
  if (expiryInfo) {
    const expSpan     = document.createElement('span');
    expSpan.className = `expiry ${expiryInfo.cls}`;
    expSpan.textContent = expiryInfo.label;
    topRow.appendChild(expSpan);

    // Refresh expiry label every second while the popup is open
    if (expiryInfo.cls !== 'expired') {
      const timer = setInterval(() => {
        const updated = formatExpiry(stream.expireTs);
        if (!updated) {
          clearInterval(timer);
          activeTimers.delete(timer);
          return;
        }
        expSpan.textContent = updated.label;
        expSpan.className   = `expiry ${updated.cls}`;
        if (updated.cls === 'expired') {
          clearInterval(timer);
          activeTimers.delete(timer);
        }
      }, 1000);
      activeTimers.add(timer);
    }
  }

  card.appendChild(topRow);

  // ── Bottom row: format selector · copy URL button ─────────────────────
  const bottomRow     = document.createElement('div');
  bottomRow.className = 'card-bottom';

  const fmtLabel     = document.createElement('span');
  fmtLabel.className = 'format-label';
  fmtLabel.textContent = 'Format:';

  const select     = document.createElement('select');
  select.className = 'format-select';

  const formats = streamType === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS;
  const defaultExt = streamType === 'video'
    ? (DEFAULT_VIDEO_EXT[stream.container] || 'mp4')
    : (DEFAULT_AUDIO_EXT[stream.container] || 'm4a');

  formats.forEach(({ ext, label }) => {
    const opt = document.createElement('option');
    opt.value = ext;
    opt.textContent = label;
    if (ext === defaultExt) opt.selected = true;
    select.appendChild(opt);
  });

  // Warn visually when a rename-only format is selected
  const muxWarning     = document.createElement('span');
  muxWarning.className = 'mux-warn';
  muxWarning.textContent = '⚠️ Rename only — use FFmpeg to convert.';
  muxWarning.style.display = 'none';

  const selectedFmt = () => formats.find((f) => f.ext === select.value);
  select.addEventListener('change', () => {
    muxWarning.style.display = selectedFmt()?.muxNeeded ? 'block' : 'none';
  });

  // Guard shared by both actions: block on an expired signed URL.
  const isExpired = () => {
    const check = formatExpiry(stream.expireTs);
    if (check && check.cls === 'expired') {
      showToast('⚠️ URL has expired — reload the source page.');
      return true;
    }
    return false;
  };

  const dlBtn     = document.createElement('button');
  dlBtn.className = 'btn-download';
  dlBtn.innerHTML = `${downloadIcon()} Download`;
  dlBtn.addEventListener('click', () => {
    if (isExpired()) return;
    if (selectedFmt()?.muxNeeded) {
      showToast('⚠️ Rename only — file needs FFmpeg conversion to play.');
    }
    triggerDownload(stream, select.value, streamType);
  });

  const copyBtn     = document.createElement('button');
  copyBtn.className = 'btn-copy';
  copyBtn.title     = 'Copy the stream URL to the clipboard';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    if (isExpired()) return;
    await copyStreamUrl(stream, select.value, streamType);
  });

  bottomRow.appendChild(fmtLabel);
  bottomRow.appendChild(select);
  bottomRow.appendChild(copyBtn);
  bottomRow.appendChild(dlBtn);
  card.appendChild(bottomRow);
  card.appendChild(muxWarning);

  return card;
}

/** Render all streams into #main-content. */
function renderStreams(videoStreams, audioStreams) {
  const main = document.getElementById('main-content');
  // Cancel all running expiry timers before replacing the DOM
  clearAllTimers();
  main.innerHTML = '';

  if (!videoStreams.length && !audioStreams.length) {
    main.innerHTML = `
      <div id="status-banner">
        <div class="status-icon">📡</div>
        <p>No streams detected yet.</p>
        <p class="hint">Play media in the active tab, then re-open this popup.</p>
      </div>`;
    return;
  }

  // ── Video section ────────────────────────────────────────────────────
  if (videoStreams.length) {
    const sec   = document.createElement('div');
    sec.className = 'section';
    sec.innerHTML = `
      <div class="section-label">
        🎥 Video streams
        <span class="count">${videoStreams.length}</span>
      </div>`;
    videoStreams.forEach((s) => sec.appendChild(buildStreamCard(s, 'video')));
    main.appendChild(sec);
  }

  // ── Audio section ────────────────────────────────────────────────────
  if (audioStreams.length) {
    const sec   = document.createElement('div');
    sec.className = 'section';
    sec.innerHTML = `
      <div class="section-label">
        🎵 Audio streams
        <span class="count">${audioStreams.length}</span>
      </div>`;
    audioStreams.forEach((s) => sec.appendChild(buildStreamCard(s, 'audio')));
    main.appendChild(sec);
  }
}

// ---------------------------------------------------------------------------
// URL field handlers
// ---------------------------------------------------------------------------

/** Normalise a user-typed URL by adding a protocol when omitted. */
function normaliseUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** True if the URL points at a YouTube watch/short/embed page. */
function isYouTubeWatchUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

/** "Go to video": open the URL in a tab so its streams get captured. */
function handleGoToVideo() {
  const url = normaliseUrl(document.getElementById('watch-url').value);
  if (!url) {
    showToast('⚠️ Enter a YouTube URL first.');
    return;
  }
  if (!isYouTubeWatchUrl(url)) {
    showToast('⚠️ That does not look like a YouTube URL.');
    return;
  }
  // Reuse the current tab when it is already on YouTube; otherwise open a new
  // one so the user's other page is left untouched.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const active = tabs && tabs[0];
    if (active && active.id != null && active.url && isYouTubeWatchUrl(active.url)) {
      chrome.tabs.update(active.id, { url });
    } else {
      chrome.tabs.create({ url });
    }
    showToast('▶️ Opening video — reopen this popup to see streams.');
    window.close();
  });
}

/** "Parse stream URL": hand a raw videoplayback URL to the background parser. */
function handleParseStreamUrl() {
  const input = document.getElementById('stream-url');
  const url = normaliseUrl(input.value);
  if (!url) {
    showToast('⚠️ Paste a stream URL first.');
    return;
  }
  if (!/googlevideo\.com/i.test(url) || !url.includes('/videoplayback')) {
    showToast('⚠️ Expected a googlevideo /videoplayback URL.');
    return;
  }
  chrome.runtime.sendMessage({ type: 'parseStreamUrl', url }, (res) => {
    if (chrome.runtime.lastError) {
      showToast('❌ Could not reach the background worker.');
      return;
    }
    if (res && res.ok) {
      input.value = '';
      showToast(`✅ Parsed ${res.streamType} stream.`);
      // The storage.onChanged listener re-renders the cards automatically.
    } else {
      showToast(`⚠️ ${res && res.error ? res.error : 'Could not parse that URL.'}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function loadAndRender() {
  chrome.storage.local.get(['videoStreams', 'audioStreams'], (result) => {
    renderStreams(result.videoStreams || [], result.audioStreams || []);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadAndRender();

  // Re-render when storage changes (e.g., background.js captured a new stream)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('videoStreams' in changes || 'audioStreams' in changes)) {
      loadAndRender();
    }
  });

  // Clear button
  document.getElementById('btn-clear').addEventListener('click', () => {
    chrome.storage.local.set({ videoStreams: [], audioStreams: [] }, () => {
      showToast('🗑️ Streams cleared.');
    });
  });

  // URL fields
  const watchInput  = document.getElementById('watch-url');
  const streamInput = document.getElementById('stream-url');
  document.getElementById('btn-go').addEventListener('click', handleGoToVideo);
  document.getElementById('btn-parse').addEventListener('click', handleParseStreamUrl);
  watchInput.addEventListener('keydown',  (e) => { if (e.key === 'Enter') handleGoToVideo(); });
  streamInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleParseStreamUrl(); });
});
