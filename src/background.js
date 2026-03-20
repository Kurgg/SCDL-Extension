const tabState = new Map();

function getOrCreateState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, {
      chunkSet: new Set(),
      chunkTemplate: null,
      playlists: new Set(),
      lastSeenAt: Date.now()
    });
  }

  const state = tabState.get(tabId);
  state.lastSeenAt = Date.now();
  return state;
}

function parseChunkTemplate(urlString) {
  const url = new URL(urlString);
  const match = url.pathname.match(/\/(data)(\d+)\.m4s$/i);
  if (!match) {
    return null;
  }

  return {
    index: Number(match[2]),
    template: `${url.origin}${url.pathname.replace(/\d+\.m4s$/i, "{index}.m4s")}${url.search}`
  };
}

function isPlaylistUrl(urlString) {
  return /\.m3u8(\?|$)/i.test(urlString);
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode !== 200) {
      return;
    }

    const state = getOrCreateState(details.tabId);

    if (isPlaylistUrl(details.url)) {
      state.playlists.add(details.url);
      return;
    }

    const parsed = parseChunkTemplate(details.url);
    if (!parsed) {
      return;
    }

    state.chunkSet.add(parsed.index);
    state.chunkTemplate = parsed.template;
  },
  { urls: ["https://playback.media-streaming.soundcloud.cloud/*"] }
);

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get-capture-status") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No active tab context" });
      return;
    }

    const state = tabState.get(tabId);
    sendResponse({
      ok: true,
      seenChunks: state?.chunkSet?.size ?? 0,
      seenPlaylists: state?.playlists?.size ?? 0,
      canDownload: Boolean(
        (state?.chunkTemplate && (state?.chunkSet?.size ?? 0) > 0) ||
          (state?.playlists && state.playlists.size > 0)
      )
    });
    return;
  }

  if (message?.type === "download-track") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No active tab context" });
      return;
    }

    const state = tabState.get(tabId);
    if (!state) {
      sendResponse({ ok: false, error: "No stream data captured yet. Play the track first." });
      return;
    }

    buildAndDownload(state, message.meta)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }
});

async function buildAndDownload(state, meta) {
  let build;

  if (state.playlists.size > 0) {
    build = await buildFromBestPlaylist([...state.playlists]);
  }

  if (!build && state.chunkTemplate && state.chunkSet.size > 0) {
    build = await buildFromChunkPattern(state.chunkTemplate, [...state.chunkSet]);
  }

  if (!build || !build.buffers.length) {
    throw new Error("Unable to rebuild audio. Play the track for longer and retry.");
  }

  const artist = sanitize(meta?.artist || "unknown-artist");
  const title = sanitize(meta?.title || "unknown-track");
  const ext = build.ext || "m4a";
  const filename = `SoundCloud/${artist} - ${title}.${ext}`;

  const dataUrl = arrayBuffersToDataUrl(build.buffers, build.mime);

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,
    conflictAction: "uniquify"
  });

  return {
    downloadId,
    filename,
    chunks: build.buffers.length,
    mode: build.mode,
    quality: build.quality
  };
}

async function buildFromBestPlaylist(playlistUrls) {
  for (const playlistUrl of playlistUrls.reverse()) {
    try {
      const rootText = await fetchText(playlistUrl);
      const mediaPlaylistUrl = await resolveMediaPlaylistUrl(rootText, playlistUrl);
      const mediaText = await fetchText(mediaPlaylistUrl);
      const segmentUrls = parseSegmentUrls(mediaText, mediaPlaylistUrl);
      if (!segmentUrls.length) {
        continue;
      }

      const buffers = await fetchAllBuffers(segmentUrls);
      if (!buffers.length) {
        continue;
      }

      const quality = extractBandwidth(rootText);
      const hasTs = segmentUrls.some((u) => /\.ts(\?|$)/i.test(u));
      return {
        mode: "hls",
        quality: quality ? `${Math.round(quality / 1000)} kbps variant` : "best available variant",
        buffers,
        mime: hasTs ? "video/mp2t" : "audio/mp4",
        ext: hasTs ? "ts" : "m4a"
      };
    } catch (_error) {
      // try next captured playlist
    }
  }

  return null;
}

async function resolveMediaPlaylistUrl(rootText, rootUrl) {
  if (!/#EXT-X-STREAM-INF/i.test(rootText)) {
    return rootUrl;
  }

  const lines = rootText.split(/\r?\n/);
  let best = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
    const bandwidth = bandwidthMatch ? Number(bandwidthMatch[1]) : 0;
    const nextLine = lines[i + 1]?.trim();
    if (!nextLine || nextLine.startsWith("#")) {
      continue;
    }

    if (!best || bandwidth > best.bandwidth) {
      best = {
        bandwidth,
        url: new URL(nextLine, rootUrl).toString()
      };
    }
  }

  return best?.url || rootUrl;
}

function parseSegmentUrls(mediaText, mediaUrl) {
  const lines = mediaText.split(/\r?\n/);
  const urls = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const mapMatch = line.match(/URI="([^"]+)"/i);
      if (mapMatch?.[1]) {
        urls.push(new URL(mapMatch[1], mediaUrl).toString());
      }
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    urls.push(new URL(line, mediaUrl).toString());
  }

  return urls;
}

async function buildFromChunkPattern(template, chunkNumbers) {
  const sorted = [...new Set(chunkNumbers)].sort((a, b) => a - b);
  const first = sorted[0];
  const maxAttempts = Math.max(first + 3000, sorted[sorted.length - 1] + 100);

  const buffers = [];
  let misses = 0;

  for (let n = first; n <= maxAttempts; n += 1) {
    const url = template.replace("{index}", String(n).padStart(3, "0"));

    try {
      const response = await fetch(url);
      if (!response.ok) {
        misses += 1;
      } else {
        buffers.push(await response.arrayBuffer());
        misses = 0;
      }
    } catch (_error) {
      misses += 1;
    }

    if (misses >= 6) {
      break;
    }
  }

  if (!buffers.length) {
    return null;
  }

  return {
    mode: "chunk-pattern",
    quality: "captured stream variant",
    buffers,
    mime: "audio/mp4",
    ext: "m4a"
  };
}

async function fetchAllBuffers(urls) {
  const buffers = [];
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Segment fetch failed (${response.status})`);
    }
    buffers.push(await response.arrayBuffer());
  }
  return buffers;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.text();
}

function extractBandwidth(text) {
  const matches = [...text.matchAll(/BANDWIDTH=(\d+)/gi)].map((m) => Number(m[1]));
  return matches.length ? Math.max(...matches) : null;
}

function arrayBuffersToDataUrl(buffers, mimeType) {
  let totalLength = 0;
  const uints = buffers.map((buffer) => {
    const arr = new Uint8Array(buffer);
    totalLength += arr.byteLength;
    return arr;
  });

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of uints) {
    merged.set(arr, offset);
    offset += arr.byteLength;
  }

  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < merged.length; i += chunkSize) {
    const slice = merged.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}

function sanitize(value) {
  return value
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
