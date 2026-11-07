const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 4000;
const BASE_DIR = path.join(__dirname);
const DEFAULT_FOLDER = "downloads";
const downloads = [];

app.use(cors());
app.use(bodyParser.json());

// Créer le dossier de téléchargement s'il n'existe pas
if (!fs.existsSync(path.join(BASE_DIR, DEFAULT_FOLDER))) {
  fs.mkdirSync(path.join(BASE_DIR, DEFAULT_FOLDER), { recursive: true });
}

app.post("/download", async (req, res) => {
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

  const outputPath = path.join(folder, "%(title)s.mp3").replace(/\\/g, "/");
  let command = `yt-dlp -t mp3 --embed-thumbnail --embed-metadata -o "${outputPath}"`;
  if (isPlaylist==false) {
    command += ' --no-playlist';
  }
  
  command += ` "${url}"`;
  const entry = {
    id,
    url,
    isPlaylist,
    folder,
    progress: 0,
    status: "downloading",
    filename: null,
  };

  downloads.unshift(entry);

  // Exécuter la commande
  const process = exec(command, { cwd: BASE_DIR }, (error, stdout, stderr) => {
    console.log("▶️ Lancement yt-dlp :", command);
    if (error) {
      console.error("⛔ yt-dlp error:\n", stderr);
      entry.status = "error";
      return;
    }

    entry.status = "completed";
    
    // Trouver le fichier téléchargé
    const files = fs.readdirSync(targetDir)
      .filter(f => f.endsWith(".mp3"))
      .map(f => ({
        name: f,
        time: fs.statSync(path.join(targetDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);

    entry.filename = files.length > 0 ? files[0].name : "Inconnu";
  });

  // Capturer la progression
  process.stdout.on("data", (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const match = line.match(/(\d{1,3}\.\d+)%/);
      if (match) {
        entry.progress = parseFloat(match[1]);
      }
    }
  });

  res.json({ message: "Téléchargement lancé", id });
});

app.get("/downloads", (req, res) => {
  res.json({ downloads });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend lancé sur http://localhost:${PORT}`);
});