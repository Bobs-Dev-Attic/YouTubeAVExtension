/**
 * background.js — AV stream inspector service worker
 *
 * Listens for media stream requests on googlevideo.com,
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
  401: { type: 'video', quality: '2160p',   codec: 'AV1',   container: 'mp4'  },
  // ── 1440p ────────────────────────────────────────────────────────────────
  264: { type: 'video', quality: '1440p',   codec: 'H.264', container: 'mp4'  },
  271: { type: 'video', quality: '1440p',   codec: 'VP9',   container: 'webm' },
  400: { type: 'video', quality: '1440p',   codec: 'AV1',   container: 'mp4'  },
  // ── 1080p ────────────────────────────────────────────────────────────────
  299: { type: 'video', quality: '1080p60', codec: 'H.264', container: 'mp4'  },
  303: { type: 'video', quality: '1080p60', codec: 'VP9',   container: 'webm' },
  399: { type: 'video', quality: '1080p',   codec: 'AV1',   container: 'mp4'  },
  137: { type: 'video', quality: '1080p',   codec: 'H.264', container: 'mp4'  },
  248: { type: 'video', quality: '1080p',   codec: 'VP9',   container: 'webm' },
  // ── 720p ─────────────────────────────────────────────────────────────────
  298: { type: 'video', quality: '720p60',  codec: 'H.264', container: 'mp4'  },
  302: { type: 'video', quality: '720p60',  codec: 'VP9',   container: 'webm' },
  398: { type: 'video', quality: '720p',    codec: 'AV1',   container: 'mp4'  },
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
  258: { type: 'audio', quality: '384kbps', codec: 'AAC',   container: 'm4a'  },
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
  '50kbps', '48kbps', '70kbps', '128kbps', '160kbps', '256kbps', '384kbps',
];

function qualityRank(quality, order) {
  const idx = order.indexOf(quality);
  return idx === -1 ? -1 : idx;
}

/**
 * Parse a MIME parameter into safe metadata for stream type/container fallback.
 * Example input: "audio/webm; codecs=\"opus\""
 */
function parseMime(mimeParam) {
  const raw = (mimeParam || '').trim().toLowerCase();
  const base = raw.split(';', 1)[0].trim(); // "audio/webm"
  const [type = '', subtype = ''] = base.split('/');
  const container = subtype.split('.', 1)[0] || 'bin';
  return { base, type, container };
}

function buildStreamKey({ itag, mime, audioTrack, lang }) {
  return [itag, mime || '', audioTrack || '', lang || ''].join('|');
}

// Serialize storage writes to avoid read-modify-write races under burst traffic.
let storageWriteQueue = Promise.resolve();
const tabNavigationKeys = new Map();

function queueStorageUpdate(storageKey, mutate) {
  storageWriteQueue = storageWriteQueue
    .then(
      () => new Promise((resolve) => {
        chrome.storage.local.get([storageKey], (result) => {
          const current = Array.isArray(result[storageKey]) ? result[storageKey] : [];
          const next = mutate(current.slice());
          chrome.storage.local.set({ [storageKey]: next }, resolve);
        });
      }),
    )
    .catch((err) => {
      console.error('[YT-AV] Storage queue error:', err?.message || err);
    });
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
      const mimeParam = params.get('mime') || '';
      const { base: mime, type: mimeType, container: mimeContainer } = parseMime(mimeParam);
      const itag    = parseInt(params.get('itag') || '0', 10);
      const expire  = params.get('expire') || '';
      const quality = params.get('quality') || '';
      const lang = params.get('lang') || '';
      const audioTrack = params.get('audio_track') || params.get('xtags') || '';

      let streamType = null;
      if (mimeType === 'video')      streamType = 'video';
      else if (mimeType === 'audio') streamType = 'audio';
      if (!streamType) return;

      const itagInfo   = ITAG_INFO[itag] || null;
      const streamKey = buildStreamKey({ itag, mime, audioTrack, lang });
      const streamInfo = {
        url,
        streamKey,
        itag,
        mime,
        quality:   itagInfo ? itagInfo.quality   : (quality || 'Unknown'),
        codec:     itagInfo ? itagInfo.codec      : 'Unknown',
        container: itagInfo ? itagInfo.container  : mimeContainer,
        expireTs:  expire ? parseInt(expire, 10) * 1000 : null,
        capturedAt: Date.now(),
        lang,
        audioTrack,
      };

      const storageKey   = streamType === 'video' ? 'videoStreams' : 'audioStreams';
      const qualityOrder = streamType === 'video' ? VIDEO_QUALITY_ORDER : AUDIO_QUALITY_ORDER;

      queueStorageUpdate(storageKey, (streams) => {
        const idx = streams.findIndex((s) => s.streamKey === streamKey);
        if (idx >= 0) {
          // Preserve the original discovery timestamp so the user always sees
          // when the stream was *first* captured, even as YouTube rotates the
          // signed URL on subsequent requests for the same ITAG.
          streamInfo.capturedAt = streams[idx].capturedAt;
          streams[idx] = streamInfo;   // refresh stale URL
        } else {
          streams.push(streamInfo);
        }
        // Highest quality first
        streams.sort(
          (a, b) => qualityRank(b.quality, qualityOrder) - qualityRank(a.quality, qualityOrder),
        );
        return streams;
      });
    } catch (e) {
      // Log parse failures so they are visible in the service worker console
      console.error('[YT-AV] Failed to parse videoplayback URL:', e.message, details.url);
    }
  },
  { urls: ['*://*.googlevideo.com/videoplayback*'] },
);

// ---------------------------------------------------------------------------
// Clear stored streams whenever the active tab navigates to a new page context.
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    try {
      const url = new URL(tab.url);
      const navKey = `${url.origin}${url.pathname}?v=${url.searchParams.get('v') || ''}`;
      const previousKey = tabNavigationKeys.get(tabId);
      if (navKey !== previousKey) {
        tabNavigationKeys.set(tabId, navKey);
        chrome.storage.local.set({ videoStreams: [], audioStreams: [] });
      }
    } catch (e) {
      console.error('[YT-AV] Failed to parse tab URL for reset logic:', e.message, tab.url);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabNavigationKeys.delete(tabId);
});
