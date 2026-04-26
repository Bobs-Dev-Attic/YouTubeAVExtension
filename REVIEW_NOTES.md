# YouTube AV Extension: Issues, Bugs, and Improvements

## High impact bugs

1. **Container parsing can be incorrect for MIME strings with codec parameters**
   - Current fallback uses `mime.split('/')[1]`, which can produce values like `webm; codecs="opus"` instead of `webm`.
   - This breaks default format selection and can display odd container labels.

2. **Race condition when capturing many streams quickly**
   - `chrome.storage.local.get(...)` + mutate + `set(...)` is non-atomic.
   - Multiple concurrent requests can overwrite each other and lose entries.

3. **Deduplication by only `itag` can collapse distinct streams**
   - Streams with same itag but different attributes (e.g., language/audio track variants) can overwrite each other.

## Medium impact issues

4. **Data reset can happen too aggressively**
   - On any `youtube.com/watch` loading event, the extension clears streams.
   - This may erase data during refreshes or intermediate navigations before new captures arrive.

5. **Hardcoded ITAG map is incomplete and may age quickly**
   - New/less-common itags appear as Unknown quality/codec.

6. **Potential user confusion around rename-only formats**
   - `.avi` and `.mp3` options are rename-only, not conversion.
   - There is a warning, but users may still expect transcoding.

## Suggested improvements

- Parse container robustly from MIME (split on `;` first, then parse type/subtype).
- Serialize storage writes (simple in-memory queue/mutex) or keep state in memory and debounce writes.
- Dedupe using a stronger key (`itag + mime + audioTrack/lang` when available).
- Clear streams only when video ID changes (extract `v=` and compare previous ID).
- Expand ITAG metadata and include AV1 entries; keep table update notes.
- Consider grouping downloads by current video ID/title in filename for better UX.
