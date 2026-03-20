# SoundCloud Track Backup Helper (Chrome Extension)

This extension adds a small **Download backup** button on `soundcloud.com` while you listen to a track.

It captures playlist/chunk URLs from SoundCloud playback traffic, resolves the highest-bitrate HLS variant when available, fetches all media parts, and writes one local file through Chrome downloads.

> Important: Use this only for content you are authorized to archive (for example, your own uploads).

## Output format and quality
- Preferred path: HLS `.m3u8` playlist capture, then choose the highest `BANDWIDTH` variant in that playlist.
- Fallback path: direct `dataNNN.m4s` chunk pattern reconstruction.
- The saved output usually becomes `.m4a` (AAC/fMP4 stream). In some stream layouts, it may save as `.ts`.

## Install
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`/workspace/SCDL-Extension`)

## Use
1. Open a SoundCloud track page and start playback.
2. Wait until the widget says `Ready`.
3. Click **Download backup**.
4. Choose save location when prompted.

## Troubleshooting
- If download fails, reload the page, play longer, and retry.
- Keep extension + tab open while building the local file.
- Very large tracks can hit browser memory limits when generating a single local data URL.
