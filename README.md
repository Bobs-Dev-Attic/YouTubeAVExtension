# YouTubeAVExtension

Build notes:

- This extension detects and inspects adaptive video/audio stream URLs on YouTube.
- It captures stream metadata and URLs for inspection workflows.
- It can download a selected stream directly to disk via the browser's native
  download manager.

Downloads save the raw adaptive stream as-is: a video itag produces a
video-only (silent) file and audio is a separate stream, so combining
video + audio into a single MP4 — or transcoding to MP3 — still requires an
external tool such as FFmpeg. Downloading YouTube media may conflict with
YouTube's Terms of Service and with Chrome/Edge Web Store policies; this build
is intended for local/personal use rather than store publication.
