/**
 * background.js — YouTube AV Extension service worker
 *
 * Listens for YouTube media stream requests on googlevideo.com,
 * categorises each stream (video vs audio) by MIME type and ITAG,
 * then persists a sorted list of streams to chrome.storage.local so
 * the popup can present them to the user.
 */

'use strict';

// ---------------------------------------------------------------------------
// ITAG lookup table
// Reference: https://gist.github.com/sidneys/7095afe4da4ae58694d128b1034e01e2
// ---------------------------------------------------------------------------
const ITAG_INFO = {
  // ── 4K / 2160p ──────────────────────────────────────────────────────────
  266: { type: 'video', quality: '2160p',   codec: 'H.264', container: 'mp4'  },
  313: { type: 'video', quality: '2160p',   codec: 'VP9',   container: 'webm' },
  // ── 1440p ────────────────────────────────────────────────────────────────
  264: { type: 'video', quality: '1440p',   codec: 'H.264', container: 'mp4'  },
  271: { type: 'video', quality: '1440p',   codec: 'VP9',   container: 'webm' },
  // ── 1080p ────────────────────────────────────────────────────────────────
  299: { type: 'video', quality: '1080p60', codec: 'H.264', container: 'mp4'  },
  303: { type: 'video', quality: '1080p60', codec: 'VP9',   container: 'webm' },
  137: { type: 'video', quality: '1080p',   codec: 'H.264', container: 'mp4'  },
  248: { type: 'video', quality: '1080p',   codec: 'VP9',   container: 'webm' },
  // ── 720p ─────────────────────────────────────────────────────────────────
  298: { type: 'video', quality: '720p60',  codec: 'H.264', container: 'mp4'  },
  302: { type: 'video', quality: '720p60',  codec: 'VP9',   container: 'webm' },
  136: { type: 'video', quality: '720p',    codec: 'H.264', container: 'mp4'  },
  247: { type: 'video', quality: '720p',    codec: 'VP9',   container: 'webm' },
  // ── 480p ─────────────────────────────────────────────────────────────────
  135: { type: 'video', quality: '480p',    codec: 'H.264', container: 'mp4'  },
  244: { type: 'video', quality: '480p',    codec: 'VP9',   container: 'webm' },
  // ── 360p ─────────────────────────────────────────────────────────────────
  134: { type: 'video', quality: '360p',    codec: 'H.264', container: 'mp4'  },
  243: { type: 'video', quality: '360p',    codec: 'VP9',   container: 'webm' },
  // ── 240p ─────────────────────────────────────────────────────────────────
  133: { type: 'video', quality: '240p',    codec: 'H.264', container: 'mp4'  },
  242: { type: 'video', quality: '240p',    codec: 'VP9',   container: 'webm' },
  // ── 144p ─────────────────────────────────────────────────────────────────
  160: { type: 'video', quality: '144p',    codec: 'H.264', container: 'mp4'  },
  278: { type: 'video', quality: '144p',    codec: 'VP9',   container: 'webm' },
  // ── Audio ────────────────────────────────────────────────────────────────
  141: { type: 'audio', quality: '256kbps', codec: 'AAC',   container: 'm4a'  },
  140: { type: 'audio', quality: '128kbps', codec: 'AAC',   container: 'm4a'  },
  139: { type: 'audio', quality: '48kbps',  codec: 'AAC',   container: 'm4a'  },
  251: { type: 'audio', quality: '160kbps', codec: 'Opus',  container: 'webm' },
  250: { type: 'audio', quality: '70kbps',  codec: 'Opus',  container: 'webm' },
  249: { type: 'audio', quality: '50kbps',  codec: 'Opus',  container: 'webm' },
};

// Sorted from lowest to highest quality; sort comparator reverses this so
// the highest-quality stream appears first in the stored array.
const VIDEO_QUALITY_ORDER = [
  '144p', '240p', '360p', '480p', '720p', '720p60',
  '1080p', '1080p60', '1440p', '2160p',
];
const AUDIO_QUALITY_ORDER = [
  '50kbps', '48kbps', '70kbps', '128kbps', '160kbps', '256kbps',
];

function qualityRank(quality, order) {
  const idx = order.indexOf(quality);
  return idx === -1 ? -1 : idx;
}

// ---------------------------------------------------------------------------
// webRequest listener — captures videoplayback URLs
// ---------------------------------------------------------------------------
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url } = details;
    if (!url.includes('/videoplayback')) return;

    try {
      const urlObj = new URL(url);
      const params  = urlObj.searchParams;
      const mime    = params.get('mime') || '';
      const itag    = parseInt(params.get('itag') || '0', 10);
      const expire  = params.get('expire') || '';
      const quality = params.get('quality') || '';

      let streamType = null;
      if (mime.startsWith('video/'))      streamType = 'video';
      else if (mime.startsWith('audio/')) streamType = 'audio';
      if (!streamType) return;

      const itagInfo   = ITAG_INFO[itag] || null;
      const streamInfo = {
        url,
        itag,
        mime,
        quality:   itagInfo ? itagInfo.quality   : (quality || 'Unknown'),
        codec:     itagInfo ? itagInfo.codec      : 'Unknown',
        container: itagInfo ? itagInfo.container  : (mime.split('/')[1] || 'bin'),
        expireTs:  expire ? parseInt(expire, 10) * 1000 : null,
        capturedAt: Date.now(),
      };

      const storageKey   = streamType === 'video' ? 'videoStreams' : 'audioStreams';
      const qualityOrder = streamType === 'video' ? VIDEO_QUALITY_ORDER : AUDIO_QUALITY_ORDER;

      chrome.storage.local.get([storageKey], (result) => {
        const streams = (result[storageKey] || []).slice();
        const idx     = streams.findIndex((s) => s.itag === itag);
        if (idx >= 0) {
          streamInfo.capturedAt = streams[idx].capturedAt; // preserve original discovery time
          streams[idx] = streamInfo;   // refresh stale URL
        } else {
          streams.push(streamInfo);
        }
        // Highest quality first
        streams.sort(
          (a, b) => qualityRank(b.quality, qualityOrder) - qualityRank(a.quality, qualityOrder),
        );
        chrome.storage.local.set({ [storageKey]: streams });
      });
    } catch (e) {
      // Log parse failures so they are visible in the service worker console
      console.error('[YT-AV] Failed to parse videoplayback URL:', e.message, details.url);
    }
  },
  { urls: ['*://*.googlevideo.com/videoplayback*'] },
);

// ---------------------------------------------------------------------------
// Clear stored streams whenever the user navigates to a new YouTube video
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === 'loading' &&
    tab.url &&
    tab.url.includes('youtube.com/watch')
  ) {
    chrome.storage.local.set({ videoStreams: [], audioStreams: [] });
  }
});
