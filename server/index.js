import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

dotenv.config({ path: "../.env" });

const app = express();
const PORT = 5001;

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

app.use(cors({ origin: "*" })); // restrict in production
app.use(express.json());

// Returns a single-use token so the API key never reaches the browser
app.get("/scribe-token", async (_req, res) => {
  try {
    const token = await elevenlabs.tokens.singleUse.create("realtime_scribe");
    res.json(token);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AFK token server running at http://localhost:${PORT}`);
});
