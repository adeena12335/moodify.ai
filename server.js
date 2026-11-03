require("dotenv").config();

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const { GoogleGenAI } = require("@google/genai");
const { WebSocketServer } = require("ws");

const app = express();
const httpServer = http.createServer(app);
const liveRooms = new Map();
const port = Number(process.env.PORT) || 3000;
const cataloguePath = path.join(__dirname, "public", "songs.json");
const evaluationPath = path.join(__dirname, "data", "evaluation-prompts.json");
const allowedModes = new Set(["familiar", "discover"]);
const allowedLanguages = new Set(["Hindi", "English"]);
const fallbackKeywords = {
  moods: {
    peaceful: ["peaceful", "calm", "relax", "soft", "quiet", "serene", "chill", "study"],
    happy: ["happy", "joy", "cheerful", "fun", "uplifting", "dance"],
    sad: ["sad", "heartbreak", "melancholy", "emotional", "cry"],
    energetic: ["energetic", "energy", "workout", "hype", "pump", "running"],
    romantic: ["romantic", "love", "date", "intimate"],
    focused: ["focus", "studying", "study", "concentration", "coding", "work"]
  },
  activities: ["studying", "study", "coding", "work", "workout", "running", "driving", "sleep", "travel", "party", "meditation"],
  genres: ["pop", "indie", "rock", "classical", "lo-fi", "hip hop", "rap", "r&b", "folk", "electronic", "devotional", "soundtrack"],
  languages: {
    hindi: "Hindi",
    bollywood: "Hindi",
    english: "English"
  }
};

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

function roomSnapshot(room) {
  return { id: room.id, host: room.host, members: [...room.members.values()], nowPlaying: room.nowPlaying };
}
function broadcast(room) {
  const message = JSON.stringify({ type: "room:update", room: roomSnapshot(room) });
  room.clients.forEach((client) => { if (client.readyState === 1) client.send(message); });
}
app.post("/api/rooms", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 30) : "Moodify listener";
  const id = crypto.randomBytes(3).toString("hex").toUpperCase();
  const room = { id, host: name, members: new Map([[name, { name, joinedAt: Date.now() }]]), clients: new Set(), nowPlaying: null };
  liveRooms.set(id, room);
  res.status(201).json(roomSnapshot(room));
});
app.get("/api/rooms/:roomId", (req, res) => {
  const room = liveRooms.get(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: "That live room no longer exists." });
  res.json(roomSnapshot(room));
});

function cleanList(value, allowed = null) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !allowed || allowed.has(item)))].slice(0, 5);
}

function validatePreferences(value) {
  const preferences = value && typeof value === "object" ? value : {};
  const moods = cleanList(preferences.moods);
  const languages = cleanList(preferences.languages, allowedLanguages);
  const genres = cleanList(preferences.genres);
  const activities = cleanList(preferences.activities);
  const popularity = ["low", "medium", "high"].includes(preferences.popularity) ? preferences.popularity : "medium";
  const explanation = typeof preferences.explanation === "string" ? preferences.explanation.trim().slice(0, 180) : "";
  return { moods, languages, genres, activities, popularity, explanation };
}

function valueMatches(values, targets) {
  return values.some((value) => targets.some((target) => target.toLowerCase() === value.toLowerCase()));
}

function benchmarkScore(song, preferences) {
  let score = 0;
  if (valueMatches(preferences.moods, [song.mood, ...song.tags])) score += 40;
  if (preferences.languages.includes(song.language)) score += 25;
  if (valueMatches(preferences.genres, [song.genre, ...song.tags])) score += 15;
  if (valueMatches(preferences.activities, song.activities)) score += 10;
  if (preferences.popularity === "low") score += Math.max(0, 10 - Math.round(song.popularity / 10));
  if (preferences.popularity === "high") score += Math.round(song.popularity / 10);
  return score;
}

function benchmarkMatches(songs, expected) {
  const top = songs.slice(0, 5);
  return {
    mood: expected.moods.length === 0 || top.some((song) => valueMatches(expected.moods, [song.mood, ...song.tags])),
    language: expected.languages.length === 0 || top.some((song) => expected.languages.includes(song.language)),
    activity: expected.activities.length === 0 || top.some((song) => valueMatches(expected.activities, song.activities))
  };
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function extractFallbackPreferences(query) {
  const normalized = query.toLowerCase();
  const hasWord = (term) => new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(normalized);
  const findMatches = (groups) => Object.entries(groups)
    .filter(([, terms]) => terms.some((term) => hasWord(term)))
    .map(([key]) => key);
  const moods = findMatches(fallbackKeywords.moods);
  const languages = Object.entries(fallbackKeywords.languages)
    .filter(([term]) => hasWord(term))
    .map(([, language]) => language);
  const genres = fallbackKeywords.genres.filter((genre) => hasWord(genre));
  const activities = fallbackKeywords.activities.filter((activity) => hasWord(activity));
  let popularity = "medium";
  if (/(avoid|less|unknown|hidden|indie|not popular|under the radar)/.test(normalized)) popularity = "low";
  else if (/(^|[^a-z])(popular|hit|trending|famous|mainstream)([^a-z]|$)/.test(normalized)) popularity = "high";
  return validatePreferences({
    moods,
    languages,
    genres,
    activities,
    popularity,
    explanation: "Keyword fallback understood the strongest mood, language, activity, and popularity cues."
  });
}

async function understandWithGemini(query) {
  if (!process.env.GEMINI_API_KEY) return { preferences: extractFallbackPreferences(query), fallback: true };
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Convert this music discovery request into JSON only:
"${query}"
Use exactly this shape:
{"moods":[],"languages":[],"genres":[],"activities":[],"popularity":"low|medium|high","explanation":""}
Use only languages Hindi, English. Keep each array short. Do not recommend songs or invent catalogue IDs.`,
    config: { responseMimeType: "application/json", temperature: 0.1 }
  });
  const raw = typeof response.text === "function" ? response.text() : response.text;
  return { preferences: validatePreferences(JSON.parse(raw)), fallback: false };
}

app.post("/api/understand-music", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (query.length < 3 || query.length > 500) {
    return res.status(400).json({ error: "Please enter a music request between 3 and 500 characters." });
  }
  try {
    const result = await understandWithGemini(query);
    return res.json(result);
  } catch (error) {
    console.error("Gemini unavailable; using keyword fallback:", error.message);
    return res.json({ preferences: extractFallbackPreferences(query), fallback: true });
  }
});

app.get("/api/catalogue", async (_req, res) => {
  try {
    const songs = await loadJson(cataloguePath);
    res.json(songs);
  } catch (error) {
    console.error("Catalogue load failed:", error.message);
    res.status(500).json({ error: "The music catalogue could not be loaded." });
  }
});

app.get("/api/evaluation", async (_req, res) => {
  try {
    const [songs, prompts] = await Promise.all([loadJson(cataloguePath), loadJson(evaluationPath)]);
    const results = prompts.map((test) => {
      const expected = validatePreferences(test.expected);
      const moodify = songs.map((song) => ({ ...song, benchmarkScore: benchmarkScore(song, expected) }))
        .sort((a, b) => b.benchmarkScore - a.benchmarkScore || a.popularity - b.popularity);
      const baseline = [...songs]
        .filter((song) => expected.languages.length === 0 || expected.languages.includes(song.language))
        .sort((a, b) => b.popularity - a.popularity);
      const moodifyTop = moodify.slice(0, 5);
      const baselineTop = baseline.slice(0, 5);
      return {
        id: test.id,
        prompt: test.prompt,
        moodify: { songs: moodifyTop.map((song) => song.id), matches: benchmarkMatches(moodifyTop, expected) },
        baseline: { songs: baselineTop.map((song) => song.id), matches: benchmarkMatches(baselineTop, expected) }
      };
    });
    const summarize = (system) => {
      const dimensions = ["mood", "language", "activity"];
      const totals = Object.fromEntries(dimensions.map((dimension) => [
        dimension,
        results.filter((result) => result[system].matches[dimension]).length
      ]));
      const totalChecks = dimensions.reduce((sum, dimension) => sum + totals[dimension], 0);
      return { totals, percentage: Math.round((totalChecks / (results.length * dimensions.length)) * 100) };
    };
    const fallbackPreferences = extractFallbackPreferences("Peaceful Hindi songs for studying at midnight. Avoid popular hits.");
    res.json({
      promptCount: results.length,
      catalogueCount: songs.length,
      metrics: { moodify: summarize("moodify"), baseline: summarize("baseline") },
      results,
      fallbackDemo: { query: "Peaceful Hindi songs for studying at midnight. Avoid popular hits.", preferences: fallbackPreferences, active: true }
    });
  } catch (error) {
    console.error("Evaluation failed:", error.message);
    res.status(500).json({ error: "The evaluation data could not be calculated." });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/live") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, url));
});
wss.on("connection", (client, url) => {
  const room = liveRooms.get((url.searchParams.get("room") || "").toUpperCase());
  const name = (url.searchParams.get("name") || "Guest").slice(0, 30);
  if (!room) return client.close(1008, "Room not found");
  room.clients.add(client);
  room.members.set(name, { name, joinedAt: Date.now() });
  broadcast(room);
  client.on("message", (payload) => {
    try {
      const event = JSON.parse(payload.toString());
      if (event.type === "now-playing" && event.songId) room.nowPlaying = { songId: String(event.songId), by: name, at: Date.now() };
      if (event.type === "stop-playing") room.nowPlaying = null;
      if (event.type === "chat" && typeof event.message === "string") room.lastMessage = { name, message: event.message.slice(0, 160), at: Date.now() };
      broadcast(room);
    } catch (error) { console.error("Live room message rejected:", error.message); }
  });
  client.on("close", () => { room.clients.delete(client); room.members.delete(name); broadcast(room); });
});
httpServer.listen(port, () => {
  console.log(`Moodify AI is running at http://localhost:${port}`);
  console.log(process.env.GEMINI_API_KEY ? "Gemini mode: enabled" : "Gemini mode: fallback-only (add GEMINI_API_KEY to enable AI)");
});
