const tabState = new Map();

function getOrCreateState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, {
      chunks: new Set(),
      baseUrl: null,
      query: "",
      lastSeenAt: Date.now()
    });
  }

  const state = tabState.get(tabId);
  state.lastSeenAt = Date.now();
  return state;
}

function parseChunkInfo(urlString) {
  const url = new URL(urlString);
  const match = url.pathname.match(/\/(data)(\d+)\.m4s$/i);

  if (!match) {
    return null;
  }

  const index = Number(match[2]);
  const prefixPath = url.pathname.replace(/\d+\.m4s$/i, "");

  return {
    index,
    origin: `${url.origin}${prefixPath}`,
    query: url.search
  };
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode !== 200) {
      return;
    }

    const chunkInfo = parseChunkInfo(details.url);
    if (!chunkInfo) {
      return;
    }

    const state = getOrCreateState(details.tabId);
    state.chunks.add(chunkInfo.index);
    state.baseUrl = chunkInfo.origin;
    state.query = chunkInfo.query;
  },
  {
    urls: ["https://playback.media-streaming.soundcloud.cloud/*"]
  }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

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
      seenChunks: state?.chunks?.size ?? 0,
      canDownload: Boolean(state?.baseUrl && (state?.chunks?.size ?? 0) > 0)
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
    if (!state?.baseUrl || state.chunks.size === 0) {
      sendResponse({ ok: false, error: "No captured audio segments yet. Start playback first." });
      return;
    }

    rebuildAndDownload(state, message.meta)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }
});

async function rebuildAndDownload(state, meta) {
  const chunkNumbers = [...state.chunks].sort((a, b) => a - b);
  const firstChunk = chunkNumbers[0];
  const chunks = [];

  let next = firstChunk;
  let misses = 0;
  const maxAttempts = Math.max(firstChunk + 3000, chunkNumbers[chunkNumbers.length - 1] + 100);

  while (next <= maxAttempts) {
    const chunkUrl = `${state.baseUrl}${String(next).padStart(3, "0")}.m4s${state.query}`;

    try {
      const response = await fetch(chunkUrl);
      if (!response.ok) {
        misses += 1;
      } else {
        const buffer = await response.arrayBuffer();
        chunks.push(buffer);
        misses = 0;
      }
    } catch (_error) {
      misses += 1;
    }

    if (misses >= 6) {
      break;
    }

    next += 1;
  }

  if (chunks.length === 0) {
    throw new Error("Could not fetch audio chunks. Ensure the track is playable and try again.");
  }

  const blob = new Blob(chunks, { type: "audio/mp4" });
  const objectUrl = URL.createObjectURL(blob);

  const artist = sanitize(meta?.artist || "unknown-artist");
  const title = sanitize(meta?.title || "unknown-track");
  const filename = `SoundCloud/${artist} - ${title}.m4a`;

  const downloadId = await chrome.downloads.download({
    url: objectUrl,
    filename,
    saveAs: true,
    conflictAction: "uniquify"
  });

  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

  return {
    downloadId,
    filename,
    chunks: chunks.length
  };
}

function sanitize(value) {
  return value
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
