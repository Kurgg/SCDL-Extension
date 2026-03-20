# SoundCloud Track Backup Helper (Chrome Extension)

This extension adds a small **Download backup** button on `soundcloud.com` while you listen to a track.

It watches SoundCloud segment traffic (`dataNNN.m4s`) from the browser, then rebuilds a single downloadable file (`.m4a`) from those chunks.

> Important: Use this only for content you are authorized to archive (for example, your own uploads).

## Why `.m4a` and not `.mp3`?
SoundCloud streaming chunks in this flow are AAC in MP4 segments (`audio/mp4`), so this extension rebuilds to `.m4a` directly. Browser extensions cannot reliably transcode to MP3 without heavy tooling.

## Install
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`/workspace/SCDL-Extension`)

## Use
1. Open a SoundCloud track page and start playback.
2. Wait until the widget says **Ready**.
3. Click **Download backup**.
4. Choose save location when prompted.

## Notes
- Best results when the track is fully playable in your browser session.
- If chunks stop early, play through more of the track and retry.
