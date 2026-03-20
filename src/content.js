const ROOT_ID = "sc-backup-helper";

init();

function init() {
  if (document.getElementById(ROOT_ID)) {
    return;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <button id="sc-backup-button" type="button">Download backup</button>
    <div id="sc-backup-meta"></div>
    <div id="sc-backup-status">Waiting for playback data...</div>
  `;

  document.documentElement.appendChild(root);

  const button = root.querySelector("#sc-backup-button");
  button.addEventListener("click", onDownloadClick);

  refreshStatus();
  setInterval(refreshStatus, 3000);
}

async function refreshStatus() {
  const meta = readTrackMeta();
  writeMeta(meta);

  try {
    const response = await chrome.runtime.sendMessage({ type: "get-capture-status" });
    if (!response?.ok) {
      setStatus("Could not read capture status.");
      return;
    }

    if (response.canDownload) {
      setStatus(`Ready (${response.seenChunks} chunks seen)`);
    } else {
      setStatus("Play the track to capture stream chunks.");
    }
  } catch (_error) {
    setStatus("Extension background is unavailable.");
  }
}

async function onDownloadClick() {
  const meta = readTrackMeta();
  setStatus("Building audio file... this may take a while.");

  const result = await chrome.runtime.sendMessage({
    type: "download-track",
    meta
  });

  if (!result?.ok) {
    setStatus(result?.error || "Failed to build file.");
    return;
  }

  setStatus(`Downloaded ${result.filename} (${result.chunks} chunks)`);
}

function readTrackMeta() {
  const title =
    textFrom(".playbackSoundBadge__titleLink span[aria-hidden='true']") ||
    textFrom(".soundTitle__title span") ||
    document.title.replace(/\s*\|\s*Listen online.*$/i, "").trim();

  const artist =
    textFrom(".playbackSoundBadge__lightLink") ||
    textFrom(".soundTitle__username a") ||
    "Unknown artist";

  return { title, artist };
}

function textFrom(selector) {
  return document.querySelector(selector)?.textContent?.trim() || "";
}

function writeMeta(meta) {
  const el = document.querySelector("#sc-backup-meta");
  if (!el) {
    return;
  }

  el.textContent = `${meta.artist} — ${meta.title}`;
}

function setStatus(text) {
  const el = document.querySelector("#sc-backup-status");
  if (el) {
    el.textContent = text;
  }
}
