const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 4000;
const BASE_DIR = path.join(__dirname);
const DEFAULT_FOLDER = "downloads";
const downloads = [];
const eventClients = new Set();

app.use(cors());
app.use(bodyParser.json());

if (!fs.existsSync(path.join(BASE_DIR, DEFAULT_FOLDER))) {
  fs.mkdirSync(path.join(BASE_DIR, DEFAULT_FOLDER), { recursive: true });
}

function sendEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// SSE lets the server push progress immediately while keeping GET /downloads available to older clients.
function broadcast(eventName, download) {
  const payload = { download };
  for (const response of eventClients) {
    sendEvent(response, eventName, payload);
  }
}

function parseNumber(value) {
  if (!value || value === "NA") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonString(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value || "";
  }
}

function ensureTrack(download, tracksByKey, details) {
  if (details.total) download.playlistTotal = details.total;
  if (download.isPlaylist && details.title && !details.index && !download.playlistTitle) {
    // yt-dlp can emit playlist metadata without an item index; keep the name on the parent job.
    download.playlistTitle = details.title;
  }

  if (download.isPlaylist && download.playlistTotal > 1) {
    // Once a multi-item playlist is confirmed, remove unindexed container records from its song list.
    for (const [key, item] of tracksByKey) {
      if (!item.index) {
        if (!download.playlistTitle && item.title) download.playlistTitle = item.title;
        tracksByKey.delete(key);
        download.items = download.items.filter((track) => track.id !== item.id);
      }
    }
    download.completedCount = download.items.filter((item) => item.status === "completed").length;
    if (!details.index) return null;
  }

  // Playlist index identifies an occurrence, even if a playlist repeats the same video ID.
  const key = details.index || details.videoId || "single";
  let track = tracksByKey.get(key);

  if (!track) {
    track = {
      id: `${download.id}-${key}`,
      videoId: details.videoId || null,
      title: details.title || "Préparation du titre…",
      index: details.index,
      total: details.total,
      status: "queued",
      progress: null,
      downloadedBytes: 0,
      totalBytes: null,
      speed: null,
      eta: null,
      filename: null,
      error: null,
    };
    tracksByKey.set(key, track);
    download.items.push(track);
  }

  if (details.videoId) track.videoId = details.videoId;
  if (details.title) track.title = details.title;
  if (details.index) track.index = details.index;
  if (details.total) track.total = details.total;
  return track;
}

function updateDownloadProgress(download) {
  if (download.items.length === 0) {
    download.progress = 0;
    return;
  }

  // Completed tracks contribute 100%; the current track contributes its measured byte percentage.
  const trackCount = download.playlistTotal || download.items.length;
  const completedProgress = download.items.reduce((sum, item) => {
    if (item.status === "completed") return sum + 100;
    return sum + (item.progress || 0);
  }, 0);
  download.progress = Math.round(completedProgress / trackCount);
}

function parseYtDlpLine(line, download, tracksByKey) {
  if (line.startsWith("SONORA_PROGRESS\t")) {
    // The tab-separated progress template carries identity, playlist position, byte counts, speed, and ETA.
    const [, videoId, titleJson, indexValue, totalValue, status, percentValue, downloadedValue, totalBytesValue, speedValue, etaValue] = line.split("\t");
    const track = ensureTrack(download, tracksByKey, {
      videoId,
      title: parseJsonString(titleJson),
      index: parseNumber(indexValue),
      total: parseNumber(totalValue),
    });
    if (!track) return;

    track.status = status === "finished" ? "processing" : "downloading";
    track.progress = parseNumber(percentValue);
    track.downloadedBytes = parseNumber(downloadedValue) || 0;
    track.totalBytes = parseNumber(totalBytesValue);
    track.speed = parseNumber(speedValue);
    track.eta = parseNumber(etaValue);
    if (track.progress === null && track.totalBytes > 0) {
      track.progress = Math.round((track.downloadedBytes / track.totalBytes) * 100);
    }
    download.status = "downloading";
    updateDownloadProgress(download);
    broadcast("update", download);
    return;
  }

  if (line.startsWith("SONORA_POST\t")) {
    const [, videoId, titleJson, indexValue, totalValue, status, postprocessor] = line.split("\t");
    const track = ensureTrack(download, tracksByKey, {
      videoId,
      title: parseJsonString(titleJson),
      index: parseNumber(indexValue),
      total: parseNumber(totalValue),
    });
    if (!track) return;
    track.status = status === "finished" ? "processing" : "processing";
    track.stage = postprocessor || "Conversion audio";
    broadcast("update", download);
    return;
  }

  if (line.startsWith("SONORA_FINISHED\t")) {
    // after_move fires after audio conversion, so this marks the MP3 complete rather than only the source download.
    const [, videoId, titleJson, indexValue, totalValue, filepathJson] = line.split("\t");
    const track = ensureTrack(download, tracksByKey, {
      videoId,
      title: parseJsonString(titleJson),
      index: parseNumber(indexValue),
      total: parseNumber(totalValue),
    });
    if (!track) return;
    const filepath = parseJsonString(filepathJson);
    track.status = "completed";
    track.progress = 100;
    track.stage = null;
    track.filename = filepath ? path.basename(filepath) : null;
    download.completedCount = download.items.filter((item) => item.status === "completed").length;
    if (!download.isPlaylist) download.filename = track.filename;
    updateDownloadProgress(download);
    broadcast("update", download);
  }
}

app.get("/downloads/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  // A fresh snapshot also makes EventSource reconnections self-healing.
  sendEvent(res, "snapshot", { downloads });
  eventClients.add(res);
  req.on("close", () => eventClients.delete(res));
});

app.post("/download", (req, res) => {
  const { url, isPlaylist, folderName } = req.body;
  if (!url || !url.startsWith("http")) {
    return res.status(400).json({ error: "URL non valide" });
  }

  const id = uuidv4();
  const folder = folderName?.trim() || DEFAULT_FOLDER;
  const targetDir = path.join(BASE_DIR, folder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const download = {
    id,
    url,
    isPlaylist: Boolean(isPlaylist),
    folder,
    progress: 0,
    status: "queued",
    filename: null,
    playlistTitle: null,
    playlistTotal: null,
    completedCount: 0,
    items: [],
  };
  downloads.unshift(download);
  broadcast("created", download);

  const tracksByKey = new Map();
  const outputPath = path.join(folder, "%(title)s.mp3").replace(/\\/g, "/");
  const progressTemplate = [
    "SONORA_PROGRESS",
    "%(info.id)s",
    "%(info.title)j",
    "%(info.playlist_index)s",
    "%(info.playlist_count)s",
    "%(progress.status)s",
    "%(progress._percent)s",
    "%(progress._downloaded_bytes)s",
    "%(progress._total_bytes)s",
    "%(progress._speed)s",
    "%(progress._eta)s",
  ].join("\t");
  const postprocessTemplate = [
    "SONORA_POST",
    "%(info.id)s",
    "%(info.title)j",
    "%(info.playlist_index)s",
    "%(info.playlist_count)s",
    "%(progress.status)s",
    "%(progress.postprocessor)s",
  ].join("\t");
  const finishedTemplate = [
    "SONORA_FINISHED",
    "%(id)s",
    "%(title)j",
    "%(playlist_index)s",
    "%(playlist_count)s",
    "%(filepath)j",
  ].join("\t");

  const args = [
    "-t", "mp3",
    "--newline",
    "--embed-thumbnail",
    "--embed-metadata",
    "--progress-delta", "0.5",
    "--progress-template", `download:${progressTemplate}`,
    "--progress-template", `postprocess:${postprocessTemplate}`,
    "--print", `after_move:${finishedTemplate}`,
    "-o", outputPath,
  ];
  if (!isPlaylist) args.push("--no-playlist");
  args.push(url);

  // spawn passes each option as a separate argument, so the URL and output path are never evaluated by a shell.
  const process = spawn("yt-dlp", args, { cwd: BASE_DIR, windowsHide: true });
  download.status = "downloading";
  broadcast("update", download);

  const buffers = { stdout: "", stderr: "" };
  const consumeOutput = (streamName, chunk) => {
    const combined = buffers[streamName] + chunk.toString();
    const lines = combined.split(/\r?\n/);
    buffers[streamName] = lines.pop() || "";
    for (const line of lines) parseYtDlpLine(line, download, tracksByKey);
  };

  process.stdout.on("data", (chunk) => consumeOutput("stdout", chunk));
  process.stderr.on("data", (chunk) => consumeOutput("stderr", chunk));
  process.on("error", (error) => {
    download.status = "error";
    download.error = error.message;
    if (download.items.length === 0) {
      const track = ensureTrack(download, tracksByKey, { title: "Téléchargement" });
      track.status = "error";
      track.error = "Impossible de lancer yt-dlp. Vérifiez qu’il est installé.";
    }
    broadcast("update", download);
  });

  process.on("close", (code) => {
    for (const streamName of Object.keys(buffers)) {
      if (buffers[streamName]) parseYtDlpLine(buffers[streamName], download, tracksByKey);
    }

    if (code === 0) {
      for (const track of download.items) {
        if (track.status !== "error") {
          track.status = "completed";
          track.progress = 100;
          track.stage = null;
        }
      }
      download.status = "completed";
    } else {
      download.status = download.completedCount > 0 ? "completed_with_errors" : "error";
      const activeTrack = [...download.items].reverse().find((track) => track.status !== "completed");
      if (activeTrack) {
        activeTrack.status = "error";
        activeTrack.error = "Le téléchargement de ce titre a échoué.";
      }
      download.error = `yt-dlp s’est arrêté avec le code ${code}.`;
    }

    download.completedCount = download.items.filter((item) => item.status === "completed").length;
    updateDownloadProgress(download);
    broadcast("update", download);
  });

  return res.json({ message: "Téléchargement lancé", id });
});

app.get("/downloads", (req, res) => {
  res.json({ downloads });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend lancé sur http://localhost:${PORT}`);
});
