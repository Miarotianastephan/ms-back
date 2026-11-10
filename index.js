const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const { ZipArchive } = require("archiver");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
const configuredPort = Number(process.env.PORT);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : 4000;
const STORAGE_DIR = path.resolve(process.env.SONORA_DOWNLOAD_DIR || path.join(os.tmpdir(), "sonora-downloads"));
const DEFAULT_FOLDER = "downloads";
const configuredRetentionHours = Number(process.env.SONORA_FILE_RETENTION_HOURS);
const FILE_RETENTION_MS = (Number.isFinite(configuredRetentionHours) && configuredRetentionHours > 0 ? configuredRetentionHours : 24) * 60 * 60 * 1000;
const downloads = [];
const eventClients = new Set();
const downloadDirectories = new Map();

app.use(cors());
app.use(bodyParser.json());

fs.mkdirSync(STORAGE_DIR, { recursive: true });

function persistDownload(download) {
  const jobDirectory = downloadDirectories.get(download.id);
  if (!jobDirectory) return;

  const manifest = {
    version: 1,
    savedAt: new Date().toISOString(),
    download,
  };
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const temporaryPath = path.join(jobDirectory, `.manifest-${process.pid}.tmp`);

  try {
    // Write then rename so a crash cannot leave a half-written manifest.
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest), "utf8");
    fs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    console.error("Impossible d’enregistrer le manifeste du téléchargement :", error);
  }
}

function cleanupExpiredStorage() {
  const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const now = Date.now();

  // Only UUID job folders created by Sonora are eligible for startup cleanup.
  for (const folder of fs.readdirSync(STORAGE_DIR, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const folderPath = path.join(STORAGE_DIR, folder.name);
    for (const job of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!job.isDirectory() || !jobIdPattern.test(job.name)) continue;
      const jobPath = path.join(folderPath, job.name);
      let lastFinishedAt = fs.statSync(jobPath).mtimeMs;
      const manifestPath = path.join(jobPath, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          const finishedAt = Date.parse(manifest.download?.finishedAt || "");
          if (Number.isFinite(finishedAt)) lastFinishedAt = finishedAt;
        } catch {
          // A corrupt manifest falls back to the directory's last-modified time.
        }
      }
      if (now - lastFinishedAt > FILE_RETENTION_MS) {
        fs.rmSync(jobPath, { recursive: true, force: true });
      }
    }
  }
}

function restoreDownloadsFromStorage() {
  const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  for (const folder of fs.readdirSync(STORAGE_DIR, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const folderPath = path.join(STORAGE_DIR, folder.name);

    for (const job of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!job.isDirectory() || !jobIdPattern.test(job.name)) continue;
      const jobPath = path.join(folderPath, job.name);
      const manifestPath = path.join(jobPath, "manifest.json");
      let download;

      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          download = manifest.download;
          if (!download || download.id !== job.name || !Array.isArray(download.items)) continue;
        } catch (error) {
          console.error(`Manifeste illisible dans ${jobPath} :`, error.message);
          continue;
        }
      } else {
        // Older job folders have no manifest; recover the MP3s while marking their source URL as unavailable.
        const audioFiles = fs.readdirSync(jobPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp3"))
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right));
        if (audioFiles.length === 0) continue;

        const modifiedAt = fs.statSync(jobPath).mtime;
        const isPlaylist = audioFiles.length > 1;
        download = {
          id: job.name,
          url: "",
          recovered: true,
          isPlaylist,
          folder: folder.name,
          playlistTitle: isPlaylist ? folder.name : null,
          playlistTotal: isPlaylist ? audioFiles.length : null,
          completedCount: audioFiles.length,
          progress: 100,
          status: "completed",
          filename: isPlaylist ? null : audioFiles[0],
          createdAt: modifiedAt.toISOString(),
          finishedAt: modifiedAt.toISOString(),
          items: audioFiles.map((filename, index) => ({
            id: `${job.name}-recovered-${index + 1}`,
            videoId: null,
            title: path.basename(filename, path.extname(filename)),
            index: isPlaylist ? index + 1 : null,
            total: isPlaylist ? audioFiles.length : null,
            status: "completed",
            progress: 100,
            downloadedBytes: 0,
            totalBytes: null,
            speed: null,
            eta: null,
            filename,
            error: null,
          })),
        };
      }

      let changedDuringRestore = false;
      const wasActive = ["queued", "downloading", "processing"].includes(download.status);
      download.items = download.items.map((item) => {
        const filename = item.filename ? path.basename(item.filename) : null;
        const fileExists = filename && fs.existsSync(path.join(jobPath, filename));
        if (item.status === "completed" && !fileExists && !item.fileExpired) {
          changedDuringRestore = true;
          return { ...item, fileExpired: true };
        }
        if (["queued", "downloading", "processing"].includes(item.status)) {
          changedDuringRestore = true;
          return { ...item, status: "interrupted", error: "Le backend a redémarré avant la fin de ce titre." };
        }
        return item;
      });

      download.completedCount = download.items.filter((item) => item.status === "completed").length;
      if (wasActive) {
        const allItemsCompleted = download.items.length > 0 && download.items.every((item) => item.status === "completed");
        if (allItemsCompleted) {
          download.status = "completed";
          download.progress = 100;
          download.error = null;
        } else {
          download.status = "interrupted";
          download.error = "Téléchargement interrompu par le redémarrage du backend.";
        }
        download.finishedAt = download.finishedAt || new Date().toISOString();
        changedDuringRestore = true;
      }
      const jobStats = fs.statSync(jobPath);
      if (!download.createdAt) download.createdAt = jobStats.birthtime.toISOString();
      if (!download.finishedAt && ["completed", "completed_with_errors", "error"].includes(download.status)) {
        download.finishedAt = jobStats.mtime.toISOString();
        changedDuringRestore = true;
      }
      if (!download.updatedAt) download.updatedAt = new Date().toISOString();

      downloadDirectories.set(download.id, jobPath);
      downloads.push(download);
      if (changedDuringRestore || download.recovered) persistDownload(download);
      if (["completed", "completed_with_errors", "error", "interrupted"].includes(download.status)) {
        scheduleFileCleanup(download);
      }
    }
  }

  downloads.sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
}

cleanupExpiredStorage();
restoreDownloadsFromStorage();

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

function scheduleFileCleanup(download) {
  const finishedAt = Date.parse(download.finishedAt || "");
  const expiresAt = Number.isFinite(finishedAt) ? finishedAt + FILE_RETENTION_MS : Date.now() + FILE_RETENTION_MS;
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    const jobDirectory = downloadDirectories.get(download.id);
    const relativePath = jobDirectory && path.relative(STORAGE_DIR, jobDirectory);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return;

    fs.rm(jobDirectory, { recursive: true, force: true }, (error) => {
      if (error) {
        console.error("Impossible de supprimer les fichiers temporaires :", error);
        return;
      }
      downloadDirectories.delete(download.id);
      for (const item of download.items) item.fileExpired = true;
      broadcast("update", download);
    });
  }, delay);
  timer.unref?.();
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
    download.updatedAt = new Date().toISOString();
    persistDownload(download);
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
  if (folder.length > 80 || path.basename(folder) !== folder || /[\\/<>:"|?*\0]/.test(folder) || folder === "." || folder === "..") {
    return res.status(400).json({ error: "Le nom du dossier est invalide" });
  }

  const folderRoot = path.join(STORAGE_DIR, folder);
  const jobDirectory = path.join(folderRoot, id);
  fs.mkdirSync(jobDirectory, { recursive: true });
  downloadDirectories.set(id, jobDirectory);

  const download = {
    id,
    url,
    isPlaylist: Boolean(isPlaylist),
    folder,
    progress: 0,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filename: null,
    playlistTitle: null,
    playlistTotal: null,
    completedCount: 0,
    items: [],
  };
  downloads.unshift(download);
  persistDownload(download);
  broadcast("created", download);

  const tracksByKey = new Map();
  const outputPath = path.join(jobDirectory, "%(title)s.mp3").replace(/\\/g, "/");
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
  const process = spawn("yt-dlp", args, { cwd: jobDirectory, windowsHide: true });
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
    download.updatedAt = new Date().toISOString();
    persistDownload(download);
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
    download.finishedAt = new Date().toISOString();
    download.updatedAt = download.finishedAt;
    persistDownload(download);
    broadcast("update", download);
    scheduleFileCleanup(download);
  });

  return res.json({ message: "Téléchargement lancé", id });
});

app.get("/downloads", (req, res) => {
  res.json({ downloads });
});

// Send only completed tracks and let the browser handle saving the attachment on the user's device.
app.get("/downloads/:downloadId/items/:itemId/file", (req, res) => {
  const download = downloads.find((item) => item.id === req.params.downloadId);
  if (!download) return res.status(404).json({ error: "Téléchargement introuvable" });

  const track = download.items.find((item) => item.id === req.params.itemId);
  if (!track) return res.status(404).json({ error: "Fichier introuvable" });
  if (track.status !== "completed" || !track.filename) {
    return res.status(409).json({ error: "Ce fichier n’est pas encore prêt" });
  }

  const jobDirectory = downloadDirectories.get(download.id);
  const filename = path.basename(track.filename);
  const filePath = jobDirectory && path.join(jobDirectory, filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Le fichier n’est plus disponible sur le serveur" });
  }

  return res.download(filePath, filename);
});

// Stream the finished playlist as a ZIP so the browser only has to handle one download.
app.get("/downloads/:downloadId/archive", (req, res) => {
  const download = downloads.find((item) => item.id === req.params.downloadId);
  if (!download) return res.status(404).json({ error: "Téléchargement introuvable" });
  if (!download.isPlaylist) return res.status(400).json({ error: "Cette demande ne contient pas de playlist" });
  if (!["completed", "completed_with_errors"].includes(download.status)) {
    return res.status(409).json({ error: "La playlist n’est pas encore terminée" });
  }

  const jobDirectory = downloadDirectories.get(download.id);
  const completedItems = download.items.filter((item) => item.status === "completed" && item.filename);
  const availableItems = completedItems.filter((item) => jobDirectory && fs.existsSync(path.join(jobDirectory, path.basename(item.filename))));
  if (availableItems.length === 0) return res.status(404).json({ error: "Aucun fichier terminé n’est disponible" });

  const archiveName = (download.playlistTitle || `playlist-${download.id}`)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 100);
  res.attachment(`${archiveName}.zip`);
  res.type("zip");

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", (error) => {
    if (!res.headersSent) res.status(500).json({ error: "Impossible de créer l’archive ZIP" });
    else res.destroy(error);
  });
  archive.pipe(res);

  availableItems.forEach((item, index) => {
    const filename = path.basename(item.filename);
    const position = String(item.index || index + 1).padStart(2, "0");
    archive.file(path.join(jobDirectory, filename), { name: `${position} - ${filename}` });
  });

  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend lancé sur http://localhost:${PORT}`);
});
