# Chrome Web Store + Microsoft Edge Add-ons Review Guide

This project currently has a **high policy risk** as submitted because it is explicitly designed to capture and download YouTube media stream URLs.

## 1) Biggest blocker: functionality likely violating platform/content policies

Current app behavior and description explicitly target YouTube stream capture/download.

- `manifest.json` description: "Detects and captures YouTube video and audio stream URLs for downloading."
- Host permissions target YouTube + GoogleVideo directly.
- Popup and code trigger direct media downloads.

For Chrome Web Store and Edge Add-ons, this may be interpreted as:
- enabling unauthorized downloading of copyrighted media,
- facilitating policy/TOS circumvention,
- and potentially violating restricted-content expectations.

### Recommendation

If the goal is to pass store review consistently, re-scope to a policy-safe use case:
- either remove YouTube-targeted downloading behavior,
- or redesign as a neutral media diagnostics/debug tool with no download/capture-export capability.

## 2) Reduce and justify permissions aggressively

Current permissions include:
- `webRequest`, `storage`, `downloads`, `tabs`
- host access: `*://*.googlevideo.com/*`, `*://*.youtube.com/*`

Reviewers expect least privilege. To improve approval odds:
- remove any permission not strictly required,
- avoid broad host permissions when possible,
- use optional host permissions + explicit user action,
- add in-product explanation for why each permission is needed.

## 3) Rename and rebrand to avoid trademark/confusion risk

Using "YouTube" in product name/title can trigger branding/trademark scrutiny and perceived impersonation.

### Recommendation
- rename extension to non-brand-specific wording,
- add disclaimer: "Not affiliated with Google or YouTube",
- avoid official brand/icon mimicry.

## 4) Tighten listing and transparency artifacts

Provide all artifacts stores typically check:
- clear privacy policy URL,
- single-purpose description,
- exact data usage statement (what is collected, stored, transmitted),
- support/contact page,
- changelog/release notes.

If no personal data is sent off-device, state it explicitly.

## 5) Eliminate “circumvention-like” UX language/flows

Remove wording/actions that indicate conversion/capture of protected content.

### Recommendation
- avoid “download YouTube stream” positioning in UI and listing,
- if downloads remain for policy-safe sources, require explicit user-initiated actions and strong source restrictions.

## 6) Technical hardening that helps reviews

- Add clear error handling around permission denials and expired URLs.
- Add rate limiting/debouncing for background processing to avoid abuse signals.
- Add telemetry-free mode by default (or no telemetry at all).
- Add automated checks in CI (lint + syntax + packaging validation).

## 7) Pre-submission checklist

Before submitting to either store:

1. Verify extension purpose does not violate content/copyright platform policies.
2. Verify permissions are least-privilege and justified in listing text.
3. Verify no remote code execution/eval/obfuscated code.
4. Verify privacy policy + support links are live.
5. Verify title/branding avoids trademark confusion.
6. Verify screenshots match real, policy-compliant behavior.

---

## Practical next step for this repository

To materially improve pass probability, do these first:
1. Rewrite product purpose away from YouTube downloading.
2. Update `manifest.json` name/description/permissions to match that new purpose.
3. Remove direct download pipeline for restricted providers.
4. Update popup copy and README/listing text accordingly.
