# Moodify AI

Moodify AI is a beginner-friendly, hackathon-ready music discovery dashboard. Type a natural-language request such as:

> Peaceful Hindi and English songs for studying at 2 AM. Avoid popular songs.

The server asks Gemini to extract structured preferences, validates the response, and ranks songs from the local `public/songs.json` catalogue. If Gemini is unavailable or no API key is configured, the same request is handled by a visible keyword-based fallback.

## What is included

- Dark responsive vanilla HTML/CSS/JavaScript dashboard.
- Express server with `POST /api/understand-music` and `GET /api/catalogue`.
- Secure Gemini usage through `@google/genai`; the API key never reaches the browser.
- Transparent recommendation scoring, Familiar/Discover modes, explanations, and semantic IDs (`MUS001`...).
- A generated Mood DNA fingerprint after every search showing mood, energy, focus, novelty, language, and session recipe.
- Real-time listening rooms over WebSockets with shareable room codes, live member presence, and synchronized now-playing updates.
- A persistent now-playing bar with a real Spotify search handoff for each catalogue song.
- A Stop control that clears Moodify's local/live now-playing state; Spotify playback itself remains controlled by the Spotify tab.
- LocalStorage-powered favourites, skips, feedback, and listening history.
- 80 English and Hindi catalogue records using real song titles/artists with clearly labelled demo attributes. No unverified Spotify URLs are included.
- 20 evaluation prompts in `data/evaluation-prompts.json`, a live Evaluation lab in the dashboard, and a CLI benchmark command.

## Run locally

1. Install Node.js 18 or newer.
2. Open this folder in VS Code.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Copy `.env.example` to `.env` and add a Gemini API key:

   ```env
   GEMINI_API_KEY=your_key_here
   PORT=3000
   ```

   The app still runs without a key in fallback-only mode.
5. Start the server:

   ```bash
   npm start
   ```

6. Open <http://localhost:3000>.

## Demo checklist

1. Search with the example prompt and verify the preference chips, five results, scores, and explanations.
2. Read the Mood DNA fingerprint and explain how the session recipe changes between moods, activities, and modes.
3. Switch between Familiar and Discover and search again. Discover down-ranks history and popularity.
4. Save a song, skip one, refresh the page, and inspect Favourites and Listening history.
5. Stop/unset `GEMINI_API_KEY`, restart, and search again. The amber fallback notice should appear and recommendations should continue.
6. Open **Evaluation** in the sidebar only when presenting benchmark evidence. It runs all 20 prompts against the current catalogue and compares Moodify with a popularity-only baseline. It reports whether at least one of the top five results matches each prompt's expected mood, language, and activity. The CLI equivalent is `npm run evaluate` while the server is running.
7. Click **Live room**, create a room, copy the six-character code, and open the app in a second browser window. Join with the code; members and now-playing events update live without refreshing.
8. Use **Stop** in the now-playing bar to clear the active session and broadcast the stopped state to the live room.

## Scoring

The base score is out of 100: mood 40, language 25, genre 15, activity 10, and user feedback 10. Popularity preference, skips, history, and mode then adjust the transparent ranking. Results are always selected from the local catalogue, so Gemini cannot invent songs or IDs.

## Real-time and playback notes

Live rooms use an in-memory WebSocket server (`ws`) for this hackathon deployment. Room codes, presence, and now-playing state are intentionally ephemeral and reset when the server restarts. The Play action opens a verified Spotify search URL for the song title and artist rather than inventing an unverified direct track URL. This keeps the catalogue honest while providing a real listening handoff.

## Evaluation methodology

The Evaluation lab is a catalogue-ranking benchmark, not a claim about general musical understanding. Each prompt has a manually authored expected intent in `data/evaluation-prompts.json`. The benchmark ranks the same catalogue using Moodify's intent-aware score and a popularity-only baseline. For each system, a dimension passes when at least one of its top five songs matches the expected mood, language, or activity. Results are calculated at runtime from the current catalogue and displayed with the prompt-level evidence, so the presentation can show the exact method and observed numbers.
