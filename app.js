/*
 * VoiceChat frontend.
 * Realtime signaling uses Supabase Realtime; WebRTC carries audio/screen media.
 * Add your Supabase project URL and anon key below after creating the project.
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://mdhmhlvikmtxgnjjeocf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hT2yr04ZIJOLZjMSrt7Pdg_5CaU1hW9";
const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("YOUR_") && !SUPABASE_ANON_KEY.includes("YOUR_");
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const $ = (id) => document.getElementById(id);
const lobby = $("lobby"), roomView = $("room");
const userId = sessionStorage.getItem("vc-user-id") || crypto.randomUUID();
sessionStorage.setItem("vc-user-id", userId);
const displayName = sessionStorage.getItem("vc-display-name") || "Guest " + userId.slice(0, 4);
sessionStorage.setItem("vc-display-name", displayName);
let channel = null, room = null, isOwner = false, myRole = "member";
let localStream = null, screenStream = null, micOn = false, peers = new Map(), members = new Map(), remoteStreams = new Map();
let toastTimer = null;

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function setConnection(text, online = false) {
  $("connection-label").textContent = text;
  $("connection-label").previousElementSibling.style.background = online ? "var(--green)" : "#777487";
}
function initials(name) { return name.trim().split(/\s+/).slice(0,2).map(x => x[0]).join("").toUpperCase() || "G"; }
function safeKey(name, code) { return (name.trim().toLowerCase() + "-" + code.trim()).replace(/[^a-z0-9-]/g,"-").slice(0,80); }
function showRoom() { lobby.classList.add("hidden"); roomView.classList.remove("hidden"); }
function showLobby(message = "") {
  lobby.classList.remove("hidden"); roomView.classList.add("hidden");
  $("lobby-message").textContent = message; setConnection("Not connected");
}
function requireConfig() {
  if (!configured) {
    const message = "Live rooms aren't enabled yet. Supabase setup is required first — open SETUP.md in the Voicechat GitHub repo and add your Project URL and anon key to app.js.";
    $("lobby-message").textContent = message;
    toast("Setup needed: connect the Supabase backend before creating or joining rooms.");
    setConnection("Backend not configured");
    return false;
  }
  $("lobby-message").textContent = "";
  return true;
}
function roomIdentity(name, code) {
  return { name: name.trim(), code: code.trim(), key: safeKey(name, code) };
}

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireConfig()) return;
  const name = $("create-name").value.trim(), code = $("create-code").value.trim();
  if (!name || !code) return;
  await enterRoom(roomIdentity(name, code), true);
});
$("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireConfig()) return;
  const name = $("join-name").value.trim(), code = $("join-code").value.trim();
  if (!name || !code) return;
  await enterRoom(roomIdentity(name, code), false);
});

async function enterRoom(info, create) {
  $("lobby-message").textContent = "";
  room = info;
  const ownerKey = "vc-owner-" + info.key;
  const savedOwner = localStorage.getItem(ownerKey);
  isOwner = create || savedOwner === userId;
  if (create) localStorage.setItem(ownerKey, userId);
  myRole = isOwner ? "owner" : "member";
  $("sidebar-room-name").textContent = info.name;
  $("room-title").textContent = info.name;
  $("room-heading").textContent = info.name;
  $("self-name").textContent = displayName;
  $("self-avatar").textContent = initials(displayName);
  $("self-role").textContent = isOwner ? "Room owner" : "Member";
  $("room-menu-button").classList.toggle("hidden", !isOwner);
  showRoom(); setConnection("Connecting…");
  channel = supabase.channel("voicechat:" + info.key, { config: { presence: { key: userId }, broadcast: { self: false } } });
  channel.on("presence", { event: "sync" }, syncMembers);
  channel.on("broadcast", { event: "signal" }, ({ payload }) => handleSignal(payload));
  channel.on("broadcast", { event: "moderation" }, ({ payload }) => handleModeration(payload));
  channel.on("broadcast", { event: "role" }, ({ payload }) => handleRole(payload));
  channel.on("broadcast", { event: "room-closed" }, () => { toast("The owner closed this room."); leaveRoom(false); });
  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      setConnection("Connected", true);
      await channel.track({ id: userId, name: displayName, role: myRole, joinedAt: Date.now(), micOn: false });
      syncMembers();
      if (create) toast("Room created. Share the room name and code.");
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      setConnection("Connection error"); toast("Couldn't connect. Check your Supabase setup.");
    }
  });
}

function syncMembers() {
  if (!channel) return;
  const state = channel.presenceState(), next = new Map();
  for (const [id, entries] of Object.entries(state)) {
    const p = entries[0] || {};
    next.set(id, { id, name: p.name || "Guest", role: p.role || "member", micOn: !!p.micOn });
  }
  members = next;
  renderMembers();
  for (const id of members.keys()) if (id !== userId) ensurePeer(id);
  for (const id of [...peers.keys()]) if (!members.has(id)) closePeer(id);
  $("stage-member-count").textContent = members.size;
  $("member-count").textContent = members.size;
  $("stage-title").textContent = members.size > 1 ? "You're hanging out" : "You're in the room";
  $("stage-subtitle").textContent = members.size > 1 ? "Your room is ready. Say hello!" : "Invite someone to join the conversation.";
}
function renderMembers() {
  const list = $("member-list"); list.innerHTML = "";
  for (const m of members.values()) {
    const row = document.createElement("div"); row.className = "member";
    const av = document.createElement("div"); av.className = "avatar"; av.textContent = initials(m.name);
    const meta = document.createElement("div"); meta.className = "member-meta";
    const strong = document.createElement("strong"); strong.textContent = m.name + (m.id === userId ? " (you)" : "");
    const small = document.createElement("small"); small.textContent = m.role === "owner" ? "Room owner" : m.role === "moderator" ? "Moderator" : "Member";
    meta.append(strong, small);
    const state = document.createElement("span"); state.className = "member-state" + (m.micOn ? " speaking" : ""); state.textContent = m.micOn ? "♫" : "♩";
    row.append(av, meta, state);
    if (m.id !== userId && (isOwner || myRole === "moderator")) {
      const tools = document.createElement("button"); tools.className = "member-tools"; tools.textContent = "⋯"; tools.title = "Member actions";
      tools.addEventListener("click", () => memberActions(m)); row.append(tools);
    }
    list.append(row);
  }
}
function memberActions(member) {
  const actions = [];
  if (isOwner || myRole === "moderator") actions.push(["Mute member", () => sendModeration(member.id, "mute")]);
  if (isOwner && member.role !== "moderator" && member.role !== "owner") actions.push(["Make moderator", () => promoteMember(member.id)]);
  if (!actions.length) return;
  const choice = prompt("Member: " + member.name + "\n" + actions.map((a,i) => (i+1) + ". " + a[0]).join("\n") + "\nEnter a number:");
  const action = actions[Number(choice) - 1]; if (action) action[1]();
}
function sendModeration(target, action) {
  if (!(isOwner || myRole === "moderator")) return;
  channel.send({ type: "broadcast", event: "moderation", payload: { target, action, by: userId } });
}
function promoteMember(target) {
  if (!isOwner) return;
  channel.send({ type: "broadcast", event: "role", payload: { target, role: "moderator", by: userId } });
  toast("Moderator promotion sent.");
}
function handleRole(p) {
  if (p.target !== userId || p.role !== "moderator") return;
  myRole = "moderator"; $("self-role").textContent = "Moderator"; toast("You are now a moderator.");
  channel.track({ id: userId, name: displayName, role: myRole, joinedAt: Date.now(), micOn });
}
async function handleModeration(p) {
  if (p.target !== userId || p.action !== "mute") return;
  micOn = false;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
  updateMicUI(); await channel.track({ id: userId, name: displayName, role: myRole, joinedAt: Date.now(), micOn: false });
  toast("The room team muted your microphone.");
}

async function ensureMic() {
  if (!localStream) localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return localStream;
}
async function toggleMic() {
  try {
    if (!micOn) {
      await ensureMic(); localStream.getAudioTracks().forEach(t => t.enabled = true); micOn = true;
      for (const pc of peers.values()) await addLocalAudio(pc);
    } else {
      localStream?.getAudioTracks().forEach(t => t.enabled = false); micOn = false;
    }
    updateMicUI();
    await channel.track({ id: userId, name: displayName, role: myRole, joinedAt: Date.now(), micOn });
  } catch (err) { toast(err.name === "NotAllowedError" ? "Allow microphone access in your browser to talk." : "Couldn't start the microphone."); }
}
function updateMicUI() {
  $("mic-button").classList.toggle("active", micOn);
  $("mic-button").querySelector("small").textContent = micOn ? "Mute" : "Unmute";
  $("mic-button").title = micOn ? "Mute microphone" : "Turn microphone on";
  $("mic-state").textContent = micOn ? "MIC ON" : "MIC OFF";
  $("mic-state").classList.toggle("on", micOn);
}
$("mic-button").addEventListener("click", toggleMic);

function makePeer(id) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] });
  pc.onicecandidate = (event) => { if (event.candidate) sendSignal(id, { candidate: event.candidate }); };
  pc.ontrack = (event) => { const stream = event.streams?.[0] || new MediaStream([event.track]); attachRemote(id, stream); };
  pc.onconnectionstatechange = () => { if (["failed","closed"].includes(pc.connectionState)) closePeer(id); };
  peers.set(id, pc);
  if (localStream) for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  // Pre-negotiate a video transceiver so screen sharing needs no renegotiation.
  const videoTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });
  if (screenStream?.getVideoTracks()[0]) videoTransceiver.sender.replaceTrack(screenStream.getVideoTracks()[0]).catch(() => {});
  return pc;
}
async function addLocalAudio(pc) {
  if (!localStream) return;
  const audio = localStream.getAudioTracks()[0]; if (!audio) return;
  const sender = pc.getSenders().find(s => s.track?.kind === "audio");
  if (sender) await sender.replaceTrack(audio); else pc.addTrack(audio, localStream);
}
async function ensurePeer(id) {
  if (peers.has(id) || !channel) return;
  const pc = makePeer(id);
  // A stable initiator rule prevents both browsers creating offers at once.
  if (userId.localeCompare(id) < 0) {
    try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); sendSignal(id, { description: pc.localDescription }); } catch {}
  }
}
function sendSignal(target, data) { channel?.send({ type: "broadcast", event: "signal", payload: { from: userId, target, data } }); }
async function handleSignal(p) {
  if (!p || p.target !== userId || !p.from || !p.data) return;
  let pc = peers.get(p.from) || makePeer(p.from);
  try {
    if (p.data.description) {
      await pc.setRemoteDescription(p.data.description);
      if (p.data.description.type === "offer") {
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        sendSignal(p.from, { description: pc.localDescription });
      }
    } else if (p.data.candidate) await pc.addIceCandidate(p.data.candidate);
  } catch (err) { console.warn("WebRTC signaling error", err); }
}
function attachRemote(id, stream) {
  remoteStreams.set(id, stream);
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length) {
    let audio = document.getElementById("remote-audio-" + id);
    if (!audio) { audio = document.createElement("audio"); audio.id = "remote-audio-" + id; audio.autoplay = true; audio.playsInline = true; document.body.append(audio); }
    audio.srcObject = new MediaStream(audioTracks);
    audio.play().catch(() => {});
  }
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    let card = document.getElementById("remote-screen-" + id);
    if (!card) {
      card = document.createElement("div"); card.className = "remote-screen-card"; card.id = "remote-screen-" + id;
      const label = document.createElement("div"); label.className = "screen-top";
      const who = document.createElement("span"); who.textContent = (members.get(id)?.name || "A member") + " is sharing";
      label.append(who);
      const video = document.createElement("video"); video.autoplay = true; video.playsInline = true;
      card.append(label, video); $("remote-screens").append(card);
    }
    const video = card.querySelector("video");
    video.srcObject = new MediaStream([videoTrack]);
    $("screen-area").classList.remove("hidden");
    video.play().catch(() => {});
    const removeRemoteScreen = () => {
      card.remove();
      if (!$("remote-screens").children.length && !screenStream) $("screen-area").classList.add("hidden");
    };
    videoTrack.addEventListener("ended", removeRemoteScreen, { once: true });
    videoTrack.addEventListener("mute", removeRemoteScreen, { once: true });
  }
}
function closePeer(id) {
  const pc = peers.get(id); if (pc) pc.close();
  peers.delete(id); remoteStreams.delete(id);
  document.getElementById("remote-" + id)?.remove();
  document.getElementById("remote-audio-" + id)?.remove();
  document.getElementById("remote-screen-" + id)?.remove();
  if (!$("remote-screens").children.length && !screenStream) $("screen-area").classList.add("hidden");
}

async function shareScreen() {
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) { toast("Screen sharing isn't supported in this browser."); return; }
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    const track = screenStream.getVideoTracks()[0];
    if (!track) throw new Error("No screen video track was created.");
    $("screen-video").srcObject = screenStream;
    $("screen-area").classList.remove("hidden");
    $("screen-button").classList.add("active");
    $("screen-button").querySelector("small").textContent = "Stop share";
    for (const pc of peers.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
    }
    track.addEventListener("ended", stopScreen, { once: true });
    toast("You're sharing your screen.");
  } catch (err) {
    screenStream?.getTracks().forEach(t => t.stop()); screenStream = null;
    if (err.name !== "NotAllowedError") toast("Couldn't start screen sharing. Check browser permissions.");
  }
}
function stopScreen() {
  const oldStream = screenStream; screenStream = null;
  if (oldStream) {
    for (const pc of peers.values()) { const sender = pc.getSenders().find(s => s.track?.kind === "video"); if (sender) sender.replaceTrack(null).catch(() => {}); }
    oldStream.getTracks().forEach(t => t.stop());
  }
  $("screen-video").srcObject = null;
  if (!$("remote-screens").children.length) $("screen-area").classList.add("hidden");
  $("screen-button").classList.remove("active"); $("screen-button").querySelector("small").textContent = "Share screen";
}
$("screen-button").addEventListener("click", () => screenStream ? stopScreen() : shareScreen());
$("stop-screen").addEventListener("click", stopScreen);

async function leaveRoom(returnToLobby = true) {
  stopScreen();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  for (const id of [...peers.keys()]) closePeer(id);
  if (channel) { await supabase.removeChannel(channel); channel = null; }
  micOn = false; updateMicUI(); members.clear(); room = null;
  if (returnToLobby) showLobby();
}
$("leave-button").addEventListener("click", () => leaveRoom());
$("end-button").addEventListener("click", () => leaveRoom());
$("copy-invite").addEventListener("click", async () => {
  const url = new URL(location.href); url.searchParams.set("room", room.name); url.searchParams.set("code", room.code);
  try { await navigator.clipboard.writeText(url.toString()); toast("Invite link copied."); } catch { toast("Copy isn't available. Share the room name and code."); }
});
$("room-menu-button").addEventListener("click", () => $("manage-dialog").showModal());
$("close-room-button").addEventListener("click", async () => {
  if (!isOwner) return;
  channel.send({ type: "broadcast", event: "room-closed", payload: { by: userId } });
  await leaveRoom();
  $("manage-dialog").close(); toast("You left the room.");
});
$("settings-button").addEventListener("click", async () => {
  $("settings-dialog").showModal();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    $("audio-input").innerHTML = '<option value="">Default microphone</option>';
    devices.filter(d => d.kind === "audioinput").forEach(d => {
      const option = document.createElement("option"); option.value = d.deviceId; option.textContent = d.label || "Microphone";
      $("audio-input").append(option);
    });
  } catch {}
});
$("audio-input").addEventListener("change", async (event) => {
  if (!micOn) return;
  try {
    const next = await navigator.mediaDevices.getUserMedia({ audio: event.target.value ? { deviceId: { exact: event.target.value } } : true });
    const old = localStream; localStream = next;
    for (const pc of peers.values()) await addLocalAudio(pc);
    old?.getTracks().forEach(t => t.stop());
  } catch { toast("Couldn't switch microphone."); }
});

const params = new URLSearchParams(location.search);
if (params.has("room") && params.has("code")) {
  $("join-name").value = params.get("room"); $("join-code").value = params.get("code");
  if (!configured) $("lobby-message").textContent = "Invite detected. Finish the Supabase setup to join this room.";
}
if (!navigator.mediaDevices?.getUserMedia) {
  $("lobby-message").textContent = "VoiceChat needs a modern browser and a secure HTTPS connection for microphone and screen sharing.";
}
