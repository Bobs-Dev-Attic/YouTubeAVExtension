/**
 * popup.js — YouTube AV Extension popup controller
 *
 * • Reads video/audio streams from chrome.storage.local.
 * • Renders stream cards with quality, codec, and expiry information.
 * • Provides a format selector (.mp4, .webm, .mp3, .m4a, .ogg, .avi …)
 *   and a Download button that calls chrome.downloads.download() — the
 *   browser's native download manager streams directly to disk without
 *   loading the entire file into memory.
 * • Listens for storage changes so cards update automatically while the
 *   popup is open.
 */

'use strict';

// ---------------------------------------------------------------------------
// Format options offered per stream type
// Note: the chosen extension is applied as the filename suffix only.
//       Actual format conversion (e.g., AAC → MP3) requires an external
//       muxer such as FFmpeg — left to the user as described in the issue.
// ---------------------------------------------------------------------------
const VIDEO_FORMATS = [
  { ext: 'mp4',  label: 'MP4  (.mp4)'  },
  { ext: 'webm', label: 'WebM (.webm)' },
  { ext: 'avi',  label: 'AVI  (.avi) ⚠ needs muxing' },
];

const AUDIO_FORMATS = [
  { ext: 'mp3',  label: 'MP3  (.mp3) ⚠ needs muxing' },
  { ext: 'm4a',  label: 'M4A  (.m4a)'  },
  { ext: 'ogg',  label: 'OGG  (.ogg)'  },
  { ext: 'mp4',  label: 'MP4  (.mp4)'  },
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

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Trigger a download via the browser's native download manager.
 * chrome.downloads.download() passes the URL directly to Chrome so no
 * file data is ever loaded into extension memory.
 */
function triggerDownload(stream, ext, streamType) {
  const quality  = toFilenameSegment(stream.quality);
  const codec    = toFilenameSegment(stream.codec);
  const filename = `youtube_${streamType}_${quality}_${codec}.${ext}`;

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
        if (!updated || expSpan.closest('body') === null) {
          clearInterval(timer);
          return;
        }
        expSpan.textContent = updated.label;
        expSpan.className   = `expiry ${updated.cls}`;
        if (updated.cls === 'expired') clearInterval(timer);
      }, 1000);
    }
  }

  card.appendChild(topRow);

  // ── Bottom row: format selector · download button ─────────────────────
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

  const dlBtn     = document.createElement('button');
  dlBtn.className = 'btn-download';
  dlBtn.innerHTML = `${downloadIcon()} Download`;
  dlBtn.addEventListener('click', () => {
    const expiryCheck = formatExpiry(stream.expireTs);
    if (expiryCheck && expiryCheck.cls === 'expired') {
      showToast('⚠️ URL has expired — reload the YouTube page.');
      return;
    }
    triggerDownload(stream, select.value, streamType);
  });

  bottomRow.appendChild(fmtLabel);
  bottomRow.appendChild(select);
  bottomRow.appendChild(dlBtn);
  card.appendChild(bottomRow);

  return card;
}

/** Render all streams into #main-content. */
function renderStreams(videoStreams, audioStreams) {
  const main = document.getElementById('main-content');
  main.innerHTML = '';

  if (!videoStreams.length && !audioStreams.length) {
    main.innerHTML = `
      <div id="status-banner">
        <div class="status-icon">📡</div>
        <p>No streams detected yet.</p>
        <p class="hint">Play a video on YouTube, then re-open this popup.</p>
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
});
