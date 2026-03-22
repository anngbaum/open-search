# TODO

## Image Metadata Support

### Level 1 — Attachment Metadata (sync metadata only, no file copying)

- [ ] Add `attachment` table to PGLite schema:
  - `id` (INTEGER PRIMARY KEY — maps to ROWID)
  - `guid` (TEXT UNIQUE)
  - `filename` (TEXT — original path in `~/Library/Messages/Attachments/`)
  - `mime_type` (TEXT)
  - `uti` (TEXT — Apple's Uniform Type Identifier)
  - `total_bytes` (INTEGER)
  - `transfer_name` (TEXT — human-readable filename like `Screenshot 2026-03-13 at 17.32.10.png`)
  - `is_sticker` (BOOLEAN)
  - `transfer_state` (INTEGER — 5 = available locally, 0 = in-flight)
- [ ] Add `message_attachment_join` table (`message_id`, `attachment_id`)
- [ ] Add `extractAttachments()` and `extractMessageAttachmentJoins()` to `src/etl/extract.ts`
- [ ] Add `loadAttachments()` and `loadMessageAttachmentJoins()` to `src/etl/load.ts`
- [ ] Add `Attachment` and `MessageAttachmentJoin` interfaces to `src/types.ts`
- [ ] Wire into sync/ingest/resync commands
- [ ] Include attachment info in thread API responses (extend `ThreadMessage`)

### Level 2 — File Import (copy actual files into app data directory)

- [ ] Copy files from `~/Library/Messages/Attachments/` into `./data/attachments/` during sync
- [ ] Skip ephemeral temp-path attachments (`/var/folders/`) — they're transient transcoding intermediates
- [ ] Handle link previews: `.pluginPayloadAttachment` files are renamed JPEGs/PNGs — detect actual format and rename
- [ ] Consider HEIC → JPEG conversion for web-friendly display (imessage-exporter uses ImageMagick for this)
- [ ] Only copy attachments with `transfer_state = 5` (fully downloaded)
- [ ] Add API endpoint to serve attachment files

### Key Data Points from chat.db

- **~36K media attachments**: 16K JPEG, 11K HEIC, 5K PNG, 1.7K MOV, 1.2K GIF
- **~30K `.pluginPayloadAttachment` files**: link preview thumbnails (actually just JPEGs)
- **18,410 messages** with `balloon_bundle_id = 'com.apple.messages.URLBalloonProvider'` (link previews)
- **~300 messages** from iMessage app extensions (OpenTable, Spotify, Venmo, GamePigeon, etc.)
- Attachment paths use hash-bucket structure: `~/Library/Messages/Attachments/<2char>/<2char>/<guid>/<filename>`
- Messages with only an image have `text = U+FFFC` (Object Replacement Character), already stripped by `transform.ts`

### Reference

- imessage-exporter's approach: https://github.com/ReagentX/imessage-exporter — offers `--copy-method` with `clone`/`basic`/`full`/`disabled` tiers and `--attachment-root` override for iOS backups

---

## Link Metadata Support

### How Links Are Stored in chat.db

Links shared in iMessage are **not plain text messages**. They use Apple's rich link system:

1. **`balloon_bundle_id`** = `'com.apple.messages.URLBalloonProvider'` on the message
2. **`text` column is almost always NULL** — only 6 out of 18,429 URL messages have the URL in the text column
3. **The URL lives in two other places:**
   - `payload_data` — a binary plist (NSKeyedArchiver) containing an `LPLinkMetadata` object (18,210 messages have this)
   - `attributedBody` — the NSAttributedString blob always contains the URL as its string content, even when `text` is NULL

### What's Inside `payload_data` (LPLinkMetadata)

The payload is an NSKeyedArchiver-encoded `LPLinkMetadata` object. Decoded, it contains:

| Field | Description | Example |
|---|---|---|
| `originalURL` | The URL as sent | `https://nextjs.org/blog/building-apis-with-nextjs#12-app-router-vs-pages-router` |
| `URL` | Canonical/resolved URL | `https://nextjs.org/blog/building-apis-with-nextjs` |
| `title` | Page title (og:title) | `Building APIs with Next.js` |
| `summary` | Page description (og:description) | `Learn about how to build APIs with Next.js.` |
| `itemType` | OpenGraph type | `article`, `video.other`, etc. |
| `twitterCard` | Twitter card type | `summary_large_image` |
| `creatorFacebookProfile` | Author name | `Lee Robinson` |
| `image` | Preview image ref (index into attachments) | `richLinkImageAttachmentSubstituteIndex: 1` |
| `icon` | Favicon ref (index into attachments) | `richLinkImageAttachmentSubstituteIndex: 0` |
| `specialization` | Platform-specific metadata (App Store, etc.) | App name, genre, subtitle, store ID |

**Specialization subtypes observed:**
- `LPiTunesMediaSoftwareMetadata` — App Store links (name, subtitle, genre, platform, storeIdentifier, screenshots)
- Generic web links — just the base LPLinkMetadata fields

### Link Preview Attachments

Each URL message typically gets **two `.pluginPayloadAttachment` files** via `message_attachment_join`:
- **Index 0**: favicon/icon (small, often ico/png)
- **Index 1**: preview image/thumbnail (larger, usually JPEG/PNG — the og:image)

One attachment is often in a `/var/folders/` temp path (0 bytes, ephemeral transcoding artifact) — skip these. The real one is in `~/Library/Messages/Attachments/`.

### Three Ways URLs Appear in Messages

| Pattern | Count | How to extract URL |
|---|---|---|
| `balloon_bundle_id = URLBalloonProvider` + `payload_data` | ~18,210 | Decode bplist → `originalURL` field |
| `balloon_bundle_id = URLBalloonProvider` + no payload | ~219 | Parse `attributedBody` NSAttributedString for the URL string |
| Plain text message containing `http` (no balloon) | rare | Regex extract from `text` column |

### Implementation Plan

#### Level 1 — Extract Link Metadata During Sync

- [ ] Add `link_preview` table to PGLite schema:
  - `id` (SERIAL PRIMARY KEY)
  - `message_id` (INTEGER FK → message, UNIQUE — one preview per message)
  - `original_url` (TEXT NOT NULL)
  - `canonical_url` (TEXT — resolved/cleaned URL)
  - `title` (TEXT)
  - `summary` (TEXT)
  - `item_type` (TEXT — og:type like `article`, `video.other`)
  - `author` (TEXT — creatorFacebookProfile or equivalent)
  - `icon_mime_type` (TEXT)
  - `image_mime_type` (TEXT)
- [ ] Write `decodeLinkPayload(payload_data: Buffer): LinkPreview` in a new `src/etl/link-preview.ts`
  - Use a bplist parser (e.g. `bplist-parser` npm package) to decode NSKeyedArchiver
  - Navigate the `$objects` array: index 2 is always the `LPLinkMetadata` dict
  - Extract `originalURL`, `URL`, `title`, `summary`, `itemType`, `creatorFacebookProfile`
  - Resolve URL UIDs via `NS.relative` field in NSURL dicts
- [ ] Fallback for messages with no `payload_data`: extract URL from `attributedBody` string content
- [ ] Add `LinkPreview` interface to `src/types.ts`
- [ ] Add `extractLinkPreviews()` to `src/etl/extract.ts` — query messages with `balloon_bundle_id = 'com.apple.messages.URLBalloonProvider'`
- [ ] Add `loadLinkPreviews()` to `src/etl/load.ts`
- [ ] Wire into sync/ingest/resync commands
- [ ] Include link preview data in thread API responses
- [ ] Index `original_url`, `title`, `summary` in text search

#### Level 2 — Link Preview Images

- [ ] During sync, copy the non-temp `.pluginPayloadAttachment` file for each URL message
- [ ] Map `richLinkImageAttachmentSubstituteIndex` to the correct attachment (0 = icon, 1 = preview image)
- [ ] Rename from `.pluginPayloadAttachment` → actual extension based on detected format (JPEG magic bytes, etc.)
- [ ] Serve via API endpoint for rendering link cards in the UI

### Key Data Points

- **18,429 total URL messages** (`balloon_bundle_id = URLBalloonProvider`)
- **18,210** have `payload_data` (decodable rich metadata)
- **219** have no payload (URL recoverable from `attributedBody`)
- **Only 6** have the URL in the `text` column
- **~30K `.pluginPayloadAttachment` files** across all balloon types (URL + app extensions)
- Common link sources: Facebook Marketplace, X/Twitter, Instagram, App Store, news articles, Next.js docs
- App Store links have extra `specialization` data (app name, genre, subtitle, screenshots)
