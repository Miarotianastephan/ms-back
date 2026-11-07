const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 4000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

app.use(cors());
app.use(bodyParser.json());

app.post("/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL manquante" });
  }
// yt-dlp -x --audio-format mp3 --audio-quality 0 -o "downloads/%(title)s.%(ext)s" "URL"
  const command = `yt-dlp -x --audio-format mp3 --postprocessor-args "-strict -2" -o "${DOWNLOAD_DIR}/%(title)s.%(ext)s" "${url}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error("Erreur:", stderr);
      return res.status(500).json({ error: "Erreur lors du téléchargement." });
    }

    const match = stdout.match(/Destination: (.+\.mp3)/);
    const filename = match ? path.basename(match[1]) : "Fichier inconnu.mp3";
    return res.json({ message: "Téléchargement terminé", filename });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend lancé sur http://localhost:${PORT}`);
});
