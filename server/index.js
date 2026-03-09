import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { Readable } from "stream";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();
const PORT = 5001;

const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenlabs = elevenlabsApiKey
  ? new ElevenLabsClient({ apiKey: elevenlabsApiKey })
  : null;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("chrome-extension://")) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);
  
app.get("/attention-companion", (_req, res) => {
  res.sendFile(path.join(__dirname, "attention-companion.html"));
});

// Returns a single-use token so the API key never reaches the browser
app.get("/scribe-token", async (_req, res) => {
  if (!elevenlabs) {
    res.status(503).json({
      error:
        "ELEVENLABS_API_KEY missing. Add it to .env if you need /scribe-token.",
    });
    return;
  }

  try {
    const token = await elevenlabs.tokens.singleUse.create("realtime_scribe");
    res.json(token);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/tts", async (req, res) => {
  const { text, voice_id = "21m00Tcm4TlvDq8ikWAM" } = req.body;
  if (!elevenlabs) {
    return res
      .status(503)
      .json({ error: "ELEVENLABS_API_KEY missing. Add it to .env." });
  }
  try {
    const audioStream = await elevenlabs.textToSpeech.convert(voice_id, {
      text,
      modelId: "eleven_turbo_v2_5",
      outputFormat: "mp3_44100_128",
    });
    res.setHeader("Content-Type", "audio/mpeg");
    Readable.fromWeb(audioStream).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AFK token server running at http://localhost:${PORT}`);
  if (!elevenlabs) {
    console.warn(
      "[AFK] ELEVENLABS_API_KEY not found. /attention-companion works, /scribe-token is disabled.",
    );
  }
});
