const state = {
  catalogue: [], mode: localStorage.getItem("moodify-mode") || "familiar",
  preferences: null, lastQuery: "", recommendations: []
};
const keys = { favourites: "moodify-favourites", history: "moodify-history", skips: "moodify-skips", feedback: "moodify-feedback" };
let liveRoom = null; let roomSocket = null; let selectedPlayingSong = null;
const getStored = (key) => JSON.parse(localStorage.getItem(key) || "[]");
const setStored = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);

async function loadCatalogue() {
  const response = await fetch("/api/catalogue");
  if (!response.ok) throw new Error("Catalogue unavailable");
  state.catalogue = await response.json();
  renderRecommendations([]);
  renderLibrary();
}

function scoreSong(song, preferences, mode) {
  const match = (values, target) => values.some((value) => target.map((item) => item.toLowerCase()).includes(value.toLowerCase()));
  let score = 0; const reasons = [];
  if (match(preferences.moods, [song.mood, ...song.tags])) { score += 40; reasons.push(`${song.mood} mood`); }
  if (preferences.languages.includes(song.language)) { score += 25; reasons.push(song.language); }
  if (match(preferences.genres, [song.genre, ...song.tags])) { score += 15; reasons.push(song.genre); }
  if (match(preferences.activities, song.activities)) { score += 10; reasons.push(song.activities[0]); }
  const feedback = getStored(keys.feedback);
  if (feedback.some((item) => item.artist === song.artist || item.genre === song.genre)) { score += 10; reasons.push("your taste"); }
  if (preferences.popularity === "low") score += Math.max(0, 10 - Math.round(song.popularity / 10));
  if (preferences.popularity === "high") score += Math.round(song.popularity / 10);
  const skips = getStored(keys.skips);
  if (skips.includes(song.id)) score -= 35;
  const history = getStored(keys.history);
  if (mode === "familiar" && history.includes(song.id)) score += 10;
  if (mode === "discover" && history.includes(song.id)) score -= 24;
  if (mode === "discover") score += Math.max(0, 10 - Math.round(song.popularity / 10));
  return { ...song, score: Math.max(0, Math.min(100, score)), reason: reasons.length ? `Matched ${reasons.slice(0, 3).join(", ")}.` : "A fresh catalogue pick that complements your request." };
}

function recommend(preferences) {
  return state.catalogue.map((song) => scoreSong(song, preferences, state.mode))
    .sort((a, b) => b.score - a.score).slice(0, 5);
}

function card(song) {
  const favourites = getStored(keys.favourites); const liked = favourites.includes(song.id);
  const colors = [["#514080","#bc70b8"],["#194d67","#8a62cc"],["#7b4154","#db926b"],["#24564d","#8cbb78"],["#3f3870","#dd6e94"]];
  const color = colors[Number(song.id.replace("MUS", "")) % colors.length];
  return `<article class="song-card" data-id="${escapeHtml(song.id)}"><div class="album-art" style="--art-a:${color[0]};--art-b:${color[1]}">${escapeHtml(song.title.slice(0, 1))}</div><div class="song-top"><div><h3 class="song-title">${escapeHtml(song.title)}</h3><p class="song-artist">${escapeHtml(song.artist)}</p></div><span class="song-id">${escapeHtml(song.id)}</span></div><div class="song-meta"><span class="meta-tag">${escapeHtml(song.language)}</span><span class="meta-tag">${escapeHtml(song.genre)}</span><span class="meta-tag">${escapeHtml(song.mood)}</span>${song.score !== undefined ? `<span class="score">${song.score}/100</span>` : ""}</div>${song.reason ? `<div class="reason">${escapeHtml(song.reason)}</div>` : ""}<div class="card-actions"><button class="icon-button ${liked ? "liked" : ""}" data-action="like">${liked ? "♥ Saved" : "♡ Save"}</button><button class="icon-button" data-action="listen">＋ Log listen</button><button class="icon-button play" data-action="play">▶ Play</button><button class="icon-button skip" data-action="skip">↗ Skip</button></div></article>`;
}

function renderRecommendations(songs) {
  $("#recommendations").innerHTML = songs.map(card).join("");
  $("#empty-home").classList.toggle("hidden", songs.length > 0);
}
function renderLibrary() {
  const favourites = getStored(keys.favourites); const history = getStored(keys.history);
  const favSongs = favourites.map((id) => state.catalogue.find((song) => song.id === id)).filter(Boolean);
  const historySongs = history.map((id) => state.catalogue.find((song) => song.id === id)).filter(Boolean);
  $("#favourites-list").innerHTML = favSongs.map(card).join(""); $("#history-list").innerHTML = historySongs.map(card).join("");
  $("#empty-favourites").classList.toggle("hidden", favSongs.length > 0); $("#empty-history").classList.toggle("hidden", historySongs.length > 0);
  $("#favourite-count").textContent = favourites.length;
}
function showToast(message) { const toast = $("#toast"); toast.textContent = message; toast.classList.add("visible"); setTimeout(() => toast.classList.remove("visible"), 3000); }
function openExternalPlayback(song) { selectedPlayingSong = song; $("#playing-title").textContent = song.title; $("#playing-artist").textContent = `${song.artist} · ${song.language}`; $("#now-playing").classList.remove("hidden"); $("#playing-open").onclick = () => window.open(`https://open.spotify.com/search/${encodeURIComponent(`${song.title} ${song.artist}`)}`, "_blank", "noopener"); if (roomSocket?.readyState === 1) roomSocket.send(JSON.stringify({ type: "now-playing", songId: song.id })); }
function stopPlayback() { selectedPlayingSong = null; $("#now-playing").classList.add("hidden"); if (roomSocket?.readyState === 1) roomSocket.send(JSON.stringify({ type: "stop-playing" })); showToast("Playback stopped."); }
async function openRoom() { $("#room-dialog").showModal(); }
function renderRoom(room) { $("#active-room-code").textContent = room.id; $("#room-members").innerHTML = room.members.map((member) => `<span>● ${escapeHtml(member.name)}</span>`).join(""); const song = state.catalogue.find((item) => item.id === room.nowPlaying?.songId); $("#room-now").textContent = song ? `${room.nowPlaying.by} is playing ${song.title} — ${song.artist}` : "No song is playing yet. Choose a song below."; }
function connectRoom(room, name) { liveRoom = room; roomSocket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live?room=${room.id}&name=${encodeURIComponent(name)}`); roomSocket.onmessage = (event) => { const data = JSON.parse(event.data); if (data.type === "room:update") renderRoom(data.room); }; roomSocket.onclose = () => showToast("Live room disconnected."); $("#room-create").classList.add("hidden"); $("#room-active").classList.remove("hidden"); renderRoom(room); }
function showSection(name) { const visibleName = ["home", "favourites", "history"].includes(name) ? name : "home"; document.querySelectorAll(".page-section").forEach((section) => section.classList.add("hidden")); $(`#${visibleName}-section`).classList.remove("hidden"); document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.section === visibleName)); if (visibleName !== "home") renderLibrary(); }

let evaluationLoaded = false;
async function loadEvaluation() {
  if (evaluationLoaded) return;
  const loading = $("#evaluation-loading"); const error = $("#evaluation-error");
  try {
    const response = await fetch("/api/evaluation"); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Evaluation failed");
    const improvement = data.metrics.moodify.percentage - data.metrics.baseline.percentage;
    $("#evaluation-headline").textContent = improvement >= 0 ? `Moodify leads by ${improvement} points.` : "The benchmark is ready for inspection.";
    $("#evaluation-subtitle").textContent = `${data.promptCount} prompts · ${data.catalogueCount} songs · three measurable intent dimensions`;
    $("#evaluation-metrics").innerHTML = ["mood", "language", "activity"].map((dimension) => `<div class="metric-card"><span>${dimension}</span><strong>${data.metrics.moodify.totals[dimension]}/${data.promptCount}</strong><small>Moodify · baseline ${data.metrics.baseline.totals[dimension]}/${data.promptCount}</small></div>`).join("") + `<div class="metric-card accent"><span>Overall relevance</span><strong>${data.metrics.moodify.percentage}%</strong><small>Baseline ${data.metrics.baseline.percentage}%</small></div>`;
    const fallback = data.fallbackDemo;
    $("#fallback-proof").innerHTML = `<span class="fallback-icon">⚡</span><strong>Fallback mode is testable</strong><p>“${escapeHtml(fallback.query)}”</p><div class="preference-summary">${[...fallback.preferences.moods, ...fallback.preferences.languages, ...fallback.preferences.activities, `${fallback.preferences.popularity} popularity`].map((item) => `<span class="preference-tag">${escapeHtml(item)}</span>`).join("")}</div>`;
    $("#evaluation-count").textContent = `${data.promptCount} measured cases`;
    $("#benchmark-table").innerHTML = data.results.map((result) => `<div class="benchmark-row"><div class="prompt-cell"><b>${escapeHtml(result.id)}</b><span>${escapeHtml(result.prompt)}</span></div><div class="checks">${["mood", "language", "activity"].map((dimension) => `<span class="${result.moodify.matches[dimension] ? "pass" : "miss"}">${result.moodify.matches[dimension] ? "✓" : "–"} ${dimension}</span>`).join("")}</div><div class="baseline-score">Baseline ${["mood", "language", "activity"].filter((dimension) => result.baseline.matches[dimension]).length}/3</div></div>`).join("");
    evaluationLoaded = true;
  } catch (loadError) { error.textContent = loadError.message; error.classList.remove("hidden"); }
  finally { loading.classList.add("hidden"); $("#evaluation-content").classList.remove("hidden"); }
}

async function handleSearch(event) {
  event.preventDefault(); const query = $("#music-query").value.trim(); if (!query) return;
  $("#loading").classList.remove("hidden"); $("#recommendations").innerHTML = ""; $("#empty-home").classList.add("hidden"); $("#fallback-banner").classList.add("hidden");
  try {
    const response = await fetch("/api/understand-music", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Search failed");
    state.preferences = data.preferences; state.lastQuery = query; state.recommendations = recommend(data.preferences);
    renderRecommendations(state.recommendations); renderPreferenceSummary(data.preferences);
    if (data.fallback) { $("#fallback-banner").classList.remove("hidden"); showToast("Fallback understanding is active."); }
  } catch (error) { showToast(error.message); $("#empty-home").classList.remove("hidden"); }
  finally { $("#loading").classList.add("hidden"); }
}
function renderPreferenceSummary(preferences) {
  const items = [...preferences.moods, ...preferences.languages, ...preferences.genres, ...preferences.activities, `${preferences.popularity} popularity`];
  $("#preference-summary").innerHTML = items.map((item) => `<span class="preference-tag">${escapeHtml(item)}</span>`).join(""); $("#preference-summary").classList.toggle("hidden", items.length === 0);
  renderMoodDna(preferences);
}
function renderMoodDna(preferences) {
  const primaryMood = preferences.moods[0] || "open-minded";
  const activity = preferences.activities[0] || "your moment";
  const language = preferences.languages.length ? preferences.languages.join(" + ") : "English and Hindi";
  const discover = state.mode === "discover";
  const values = [
    ["Mood", preferences.moods.length ? 92 : 55, primaryMood],
    ["Energy", preferences.moods.some((mood) => ["energetic", "happy"].includes(mood)) ? 88 : 42, preferences.moods.some((mood) => ["energetic", "happy"].includes(mood)) ? "uplifting" : "gentle"],
    ["Focus", preferences.activities.some((item) => ["studying", "coding", "reading", "work"].includes(item)) ? 94 : 58, preferences.activities.some((item) => ["studying", "coding", "reading", "work"].includes(item)) ? "deep work" : "easy listening"],
    ["Novelty", discover || preferences.popularity === "low" ? 86 : 38, discover || preferences.popularity === "low" ? "off the radar" : "familiar glow"]
  ];
  $("#dna-title").textContent = `${primaryMood.charAt(0).toUpperCase() + primaryMood.slice(1)} mode`;
  $("#dna-description").textContent = `A ${primaryMood} session in ${language}, tuned for ${activity}.`;
  $("#dna-bars").innerHTML = values.map(([label, amount, value]) => `<div class="dna-bar"><div><span>${label}</span><b>${value}%</b></div><div class="bar-track"><i style="width:${amount}%"></i></div><small>${value}</small></div>`).join("");
  $("#dna-recipe").textContent = `${discover ? "Serendipity on" : "Comfort-first"} · ${preferences.popularity} popularity · five-song session`;
  $("#mood-dna").classList.remove("hidden");
}
function handleCardAction(event) {
  const button = event.target.closest("[data-action]"); const cardElement = event.target.closest(".song-card"); if (!button || !cardElement) return;
  const id = cardElement.dataset.id; const song = state.catalogue.find((item) => item.id === id); if (!song) return;
  if (button.dataset.action === "like") { const favourites = getStored(keys.favourites); const next = favourites.includes(id) ? favourites.filter((item) => item !== id) : [id, ...favourites]; setStored(keys.favourites, next); setStored(keys.feedback, [{ id, artist: song.artist, genre: song.genre }, ...getStored(keys.feedback).filter((item) => item.id !== id)].slice(0, 30)); showToast(next.includes(id) ? "Saved to favourites." : "Removed from favourites."); }
  if (button.dataset.action === "skip") { setStored(keys.skips, [id, ...getStored(keys.skips).filter((item) => item !== id)].slice(0, 50)); showToast("Skipped next time. We’ll learn from that."); }
  if (button.dataset.action === "listen") { setStored(keys.history, [id, ...getStored(keys.history).filter((item) => item !== id)].slice(0, 50)); showToast("Added to listening history."); }
  if (button.dataset.action === "play") { openExternalPlayback(song); }
  renderLibrary(); if (state.recommendations.length) renderRecommendations(state.recommendations);
}
document.addEventListener("DOMContentLoaded", async () => {
  document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => showSection(link.dataset.section)));
  document.querySelectorAll(".prompt-chip").forEach((chip) => chip.addEventListener("click", () => { $("#music-query").value = chip.textContent; $("#search-form").requestSubmit(); }));
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => { state.mode = button.dataset.mode; localStorage.setItem("moodify-mode", state.mode); document.querySelectorAll(".mode-button").forEach((item) => item.classList.toggle("active", item === button)); if (state.preferences) { state.recommendations = recommend(state.preferences); renderRecommendations(state.recommendations); } }));
  $("#search-form").addEventListener("submit", handleSearch); document.addEventListener("click", handleCardAction);
  $("#room-button").addEventListener("click", openRoom); $("#room-close").addEventListener("click", () => $("#room-dialog").close()); $("#playing-stop").addEventListener("click", stopPlayback);
  $("#create-room").addEventListener("click", async () => { const name = $("#room-name").value.trim() || "Host"; const response = await fetch("/api/rooms", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name}) }); if (!response.ok) return showToast("Could not create a room."); connectRoom(await response.json(), name); });
  $("#join-room").addEventListener("click", async () => { const code = $("#room-code").value.trim().toUpperCase(); const name = $("#guest-name").value.trim() || "Guest"; const response = await fetch(`/api/rooms/${code}`); if (!response.ok) return showToast("Room code not found."); connectRoom(await response.json(), name); });
  $("#copy-room").addEventListener("click", async () => { await navigator.clipboard.writeText(liveRoom.id); showToast("Room code copied."); });
  window.addEventListener("hashchange", () => showSection(location.hash.replace("#", "") || "home"));
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  try { await loadCatalogue(); } catch { showToast("Could not load the local music catalogue."); }
  showSection(location.hash.replace("#", "") || "home");
});
