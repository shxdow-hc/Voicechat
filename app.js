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
let userId = sessionStorage.getItem("vc-user-id") || crypto.randomUUID();
let authUser = null;
const accountSessionId = crypto.randomUUID();
let accountHeartbeat = null;
let displayName = "";
let avatarData = localStorage.getItem("vc-avatar") || "";
let pendingAvatar = avatarData;
const usernameGate = $("username-gate");
$("lobby").classList.add("hidden");
usernameGate.classList.remove("hidden");
let channel = null, room = null, isOwner = false, myRole = "member";
let localStream = null, screenStream = null, micOn = false, peers = new Map(), members = new Map(), remoteStreams = new Map();
let toastTimer = null, ownerElectionTimer = null;
let isPlatformAdmin = false;
async function checkPlatformAdmin() {
  if (!authUser) return;
  const {data,error}=await supabase.from("platform_admins").select("user_id").eq("user_id",authUser.id).maybeSingle();
  isPlatformAdmin=!error && !!data;
  $("admin-open").classList.toggle("hidden",!isPlatformAdmin);
}
async function refreshAdminDashboard() {
  if(!isPlatformAdmin || !authUser) return;
  $("admin-message").textContent="Refreshing…";
  const [u,r,s]=await Promise.all([
    supabase.from("profiles").select("id,username,created_at,suspended").order("created_at",{ascending:false}).limit(500),
    supabase.from("room_sessions").select("user_id,username,room_key,room_name,room_code,last_seen").limit(1000),
    supabase.from("account_sessions").select("user_id,last_seen").limit(1000)
  ]);
  if(u.error || r.error || s.error){$("admin-message").textContent="Could not load dashboard. Run the latest supabase-auth.sql.";return;}
  const live=(r.data||[]).filter(x=>Date.now()-new Date(x.last_seen).getTime()<90000);
  const onlineIds=new Set((s.data||[]).filter(x=>Date.now()-new Date(x.last_seen).getTime()<90000).map(x=>x.user_id));
  const groups=new Map();
  live.forEach(x=>{if(!groups.has(x.room_key))groups.set(x.room_key,[]);groups.get(x.room_key).push(x);});
  $("admin-user-count").textContent=(u.data||[]).length;
  $("admin-room-count").textContent=groups.size;
  const roomBox=$("admin-rooms");roomBox.replaceChildren();
  if(!groups.size)roomBox.innerHTML='<p class="admin-empty">No active rooms.</p>';
  groups.forEach(members=>{
    const row=document.createElement("div");row.className="admin-row";
    const left=document.createElement("div"),title=document.createElement("strong"),sub=document.createElement("small"),people=document.createElement("small"),join=document.createElement("button");
    title.textContent=members[0].room_name;
    sub.textContent="Room Number: "+members[0].room_code+" · "+members.length+" member(s)";
    people.textContent="Members: "+members.map(x=>x.username).join(", ");
    left.append(title,sub,people);
    const actions=document.createElement("div");actions.style.display="flex";actions.style.gap="6px";
    join.type="button";join.className="small-button";join.textContent="Join";
    join.addEventListener("click",async()=>{$("admin-dialog").close();await enterRoom(roomIdentity(members[0].room_name,members[0].room_code),false);});
    const close=document.createElement("button");close.type="button";close.className="small-button";close.textContent="Close room";
    close.addEventListener("click",async()=>{const result=await supabase.from("room_sessions").update({force_closed:true}).eq("room_key",members[0].room_key);if(result.error){$("admin-message").textContent="Couldn't close room.";return;}await refreshAdminDashboard();});
    actions.append(join,close);row.append(left,actions);roomBox.append(row);
  });
  const userBox=$("admin-users");userBox.replaceChildren();
  (u.data||[]).forEach(user=>{
    const row=document.createElement("div");row.className="admin-row";
    const left=document.createElement("div"),title=document.createElement("strong"),sub=document.createElement("small"),status=document.createElement("small");
    title.textContent=user.username;sub.textContent="Joined "+new Date(user.created_at).toLocaleDateString();
    const inRoom=live.some(x=>x.user_id===user.id);
    status.textContent=inRoom?"Online · In a room":onlineIds.has(user.id)?"Online · In lobby":"Offline";
    const actions=document.createElement("div");actions.style.display="flex";actions.style.gap="6px";
    const suspend=document.createElement("button");suspend.type="button";suspend.className="small-button";suspend.textContent=user.suspended?"Unsuspend":"Suspend";
    suspend.addEventListener("click",async()=>{const result=await supabase.from("profiles").update({suspended:!user.suspended}).eq("id",user.id);if(result.error){$("admin-message").textContent="Couldn't update account status.";return;}await refreshAdminDashboard();});
    const revoke=document.createElement("button");revoke.type="button";revoke.className="small-button";revoke.textContent="Log out";
    revoke.addEventListener("click",async()=>{const result=await supabase.from("account_sessions").delete().eq("user_id",user.id);if(result.error){$("admin-message").textContent="Couldn't revoke session.";return;}await refreshAdminDashboard();});
    actions.append(suspend,revoke);left.append(title,sub);row.append(left,status,actions);userBox.append(row);
  });
  $("admin-message").textContent="Updated just now. Offline room activity expires after 90 seconds.";
}
$("admin-open").addEventListener("click",async()=>{if(!isPlatformAdmin)return;$("admin-dialog").showModal();await refreshAdminDashboard();});
$("admin-refresh").addEventListener("click",refreshAdminDashboard);


function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function setConnection(text, online = false) {
  $("connection-label").textContent = text;
  $("connection-label").previousElementSibling.style.background = online ? "var(--green)" : "#777487";
}
function initials(name) { return name.trim().split(/\s+/).slice(0,2).map(x => x[0]).join("").toUpperCase() || "G"; }
function setAvatar(element, avatar, name) {
  if (!element) return;
  element.replaceChildren();
  if (avatar) {
    const img = document.createElement("img");
    img.src = avatar; img.alt = name + " profile picture";
    element.append(img);
  } else element.textContent = initials(name || "Guest");
}
function updateProfilePreview() {
  $("profile-preview-name").textContent = displayName || "Guest";
  setAvatar($("profile-preview-avatar"), pendingAvatar, displayName || "Guest");
}
function updateSelfProfileUI() {
  $("self-name").textContent = displayName;
  setAvatar($("self-avatar"), avatarData, displayName);
}
function trackSelf() {
  if (!channel) return;
  return channel.track({ id: userId, name: displayName, avatar: avatarData, role: myRole, joinedAt: Date.now(), micOn });
}
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
function authMessage(message, isError = true) {
  const el = $("username-message");
  el.textContent = message;
  el.style.color = isError ? "#ff9bad" : "#68dc91";
}
function showAuthPanel(register) {
  $("auth-login-panel").classList.toggle("hidden", register);
  $("auth-register-panel").classList.toggle("hidden", !register);
  authMessage("");
}
$("show-register").addEventListener("click", () => showAuthPanel(true));
$("show-login").addEventListener("click", () => showAuthPanel(false));
function usernameEmail(username) {
  return username.trim().toLowerCase() + "@users.hcunion.invalid";
}
async function startAccountLock() {
  const { data, error } = await supabase.rpc("claim_account_session", { p_session_id: accountSessionId });
  if (error) throw new Error("Account session check failed. Run the updated supabase-auth.sql setup.");
  if (data !== true) throw new Error("This account is already being used on another device or browser. Log out there first, or wait about 90 seconds after it disconnects.");
  if (accountHeartbeat) clearInterval(accountHeartbeat);
  accountHeartbeat = setInterval(async () => {
    const { data: active, error: heartbeatError } = await supabase.rpc("refresh_account_session", { p_session_id: accountSessionId });
    if (room) { const presence=await supabase.from("room_sessions").update({last_seen:new Date().toISOString()}).eq("user_id",userId).select("force_closed").maybeSingle(); if (presence.data?.force_closed) { await leaveRoom(false); toast("The HCunion owner closed this room."); } }
    if (heartbeatError || active !== true) {
      clearInterval(accountHeartbeat); accountHeartbeat = null;
      await supabase.auth.signOut();
      authUser = null; displayName = "";
      usernameGate.classList.remove("hidden"); $("lobby").classList.add("hidden");
      authMessage("Your account session ended because it was opened somewhere else. Please log in again.");
    }
  }, 25000);
}
async function endAccountSession() {
  if (accountHeartbeat) { clearInterval(accountHeartbeat); accountHeartbeat = null; }
  if (configured && authUser) {
    try { await supabase.rpc("release_account_session", { p_session_id: accountSessionId }); } catch {}
  }
  authUser = null;
  await supabase.auth.signOut();
}
window.addEventListener("pagehide", () => {
  if (authUser && configured) {
    supabase.rpc("release_account_session", { p_session_id: accountSessionId });
  }
});
async function logoutAccount() {
  await leaveRoom(false);
  await endAccountSession();
  displayName = "";
  localStorage.removeItem("vc-display-name");
  usernameGate.classList.remove("hidden");
  $("lobby").classList.add("hidden");
  $("profile-open").classList.add("hidden");
  showAuthPanel(false);
  toast("You have been logged out.");
}
$("account-logout").addEventListener("click", logoutAccount);
async function loadAccount(user) {
  if (!user) return;
  await startAccountLock();
  const { data, error } = await supabase.from("profiles").select("username,suspended").eq("id", user.id).single();
  if (error || !data?.username) {
    authMessage("Your account profile could not be loaded. Check the Supabase SQL setup in SETUP.md.");
    return;
  }
  if (data.suspended) { await supabase.rpc("release_account_session", { p_session_id: accountSessionId }); await supabase.auth.signOut(); authMessage("This account has been suspended by the HCunion owner."); return; }
  authUser = user;
  await checkPlatformAdmin();
  userId = user.id;
  sessionStorage.setItem("vc-user-id", userId);
  displayName = data.username;
  localStorage.setItem("vc-display-name", displayName);
  updateSelfProfileUI();
  updateProfilePreview();
  $("profile-open").classList.remove("hidden");
  usernameGate.classList.add("hidden");
  $("lobby").classList.remove("hidden");
  authMessage("", false);
}
$("auth-register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) { authMessage("Account registration needs the Supabase setup. See SETUP.md."); return; }
  const username = $("register-username").value.trim();
  const password = $("register-password").value;
  const confirm = $("register-confirm").value;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) { authMessage("Use 3–20 letters, numbers, or underscores for your username."); return; }
  if (password.length < 8) { authMessage("Your password must be at least 8 characters."); return; }
  if (password !== confirm) { authMessage("The passwords don't match. Check them and try again."); return; }
  const button = $("auth-register-form").querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Creating account…";
  try {
    const { data, error } = await supabase.auth.signUp({
      email: usernameEmail(username), password,
      options: { data: { username } }
    });
    if (error) throw error;
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      authMessage("That username is already registered. Try logging in or choose another username.");
      return;
    }
    if (!data.session) {
      authMessage("Account created, but Supabase email confirmation is still on. Turn it off as explained in SETUP.md, then register again.");
      return;
    }
    await supabase.auth.signOut();
    showAuthPanel(false);
    $("login-username").value = username;
    $("login-password").value = "";
    authMessage("Account created! Please log in with your new username and password.", false);
  } catch (error) {
    const msg = String(error?.message || "");
    authMessage(/already|duplicate|unique|username|registered/i.test(msg) ? "That username is already taken. Choose another one." : /password|weak/i.test(msg) ? "Your password was rejected. Use at least 8 characters and try again." : msg || "Registration failed. Please try again.");
  } finally {
    button.disabled = false; button.innerHTML = 'Register <span>↗</span>';
  }
});
$("auth-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) { authMessage("Account login needs the Supabase setup. See SETUP.md."); return; }
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) { authMessage("Enter a valid username."); return; }
  const button = $("auth-login-form").querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Logging in…";
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: usernameEmail(username), password });
    if (error) throw error;
    try {
      await loadAccount(data.user);
    } catch (lockError) {
      await supabase.auth.signOut();
      throw lockError;
    }
    if (authUser) toast("Welcome back, " + displayName + "!");
  } catch (error) {
    const msg = String(error?.message || "");
    if (/already being used|session check failed/i.test(msg)) authMessage(msg);
    else if (/network|fetch|timeout/i.test(msg)) authMessage("Could not reach the login service. Check your internet connection and try again.");
    else authMessage("Username or password is incorrect. If you do not have an account yet, select Create an account.");
  } finally {
    button.disabled = false; button.innerHTML = 'Log in <span>↗</span>';
  }
});
if (configured) {
  // Always require a fresh login when the site is opened. Never silently reuse
  // a saved Supabase auth session from a previous visit.
  supabase.auth.getSession().then(async ({ data, error }) => {
    if (error) { authMessage("Couldn't check your login session. Please log in again."); return; }
    if (data.session) {
      try { await supabase.rpc("release_account_session", { p_session_id: accountSessionId }); } catch {}
      await supabase.auth.signOut();
    }
    showAuthPanel(false);
  });
} else {
  authMessage("Accounts are not configured yet. The owner must finish the Supabase setup in SETUP.md.");
}
updateProfilePreview();

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
  // Ownership is represented by live room presence, not a stale per-browser
  // owner flag. This allows a successor to take over after the creator leaves.
  isOwner = create;
  if (create) localStorage.setItem(ownerKey, userId);
  myRole = isOwner ? "owner" : "member";
  $("sidebar-room-name").textContent = info.name;
  $("room-title").textContent = info.name;
  $("room-heading").textContent = info.name;
  updateSelfProfileUI();
  $("self-role").textContent = isOwner ? "Room owner" : "Member";
  $("room-menu-button").classList.toggle("hidden", !isOwner);
  $("chat-messages").innerHTML = "";
  $("chat-empty").classList.remove("hidden");
  showRoom(); setConnection("Connecting…");
  await supabase.from("room_sessions").upsert({user_id:userId,username:displayName,room_key:info.key,room_name:info.name,room_code:info.code,joined_at:new Date().toISOString(),last_seen:new Date().toISOString(),force_closed:false},{onConflict:"user_id"});
  channel = supabase.channel("voicechat:" + info.key, { config: { presence: { key: userId }, broadcast: { self: false } } });
  channel.on("presence", { event: "sync" }, syncMembers);
  channel.on("broadcast", { event: "signal" }, ({ payload }) => handleSignal(payload));
  channel.on("broadcast", { event: "room-chat" }, ({ payload }) => receiveChatMessage(payload));
  channel.on("broadcast", { event: "moderation" }, ({ payload }) => handleModeration(payload));
  channel.on("broadcast", { event: "role" }, ({ payload }) => handleRole(payload));
  channel.on("broadcast", { event: "room-closed" }, () => { toast("The owner closed this room."); leaveRoom(false); });
  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      // A join attempt must find someone already present. Subscribing to a
      // Supabase channel alone does not prove that a room exists.
      if (!create && Object.keys(channel.presenceState()).length === 0) {
        await channel.unsubscribe();
        await supabase.from("room_sessions").delete().eq("user_id",userId);
        channel = null;
        room = null;
        isOwner = false;
        myRole = "member";
        showLobby("Room not found. Check the room name and Room Number, then try again.");
        return;
      }
      setConnection("Connected", true);
      await trackSelf();
      syncMembers();
      if (create) toast("Room created. Share the room name and code.");
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      setConnection("Connection error"); toast("Couldn't connect. Check your Supabase setup.");
    }
  });
}

function formatChatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function renderChatMessage(message) {
  const list = $("chat-messages");
  $("chat-empty").classList.add("hidden");
  const item = document.createElement("article");
  item.className = "chat-message";
  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  setAvatar(avatar, message.avatar || "", message.name || "Guest");
  const content = document.createElement("div");
  content.className = "chat-message-content";
  const heading = document.createElement("div");
  heading.className = "chat-message-heading";
  const name = document.createElement("strong");
  name.textContent = message.name || "Guest";
  const time = document.createElement("time");
  time.textContent = formatChatTime(message.createdAt || Date.now());
  heading.append(name, time);
  const body = document.createElement("p");
  body.textContent = message.text;
  content.append(heading, body);
  item.append(avatar, content);
  list.append(item);
  while (list.children.length > 100) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
}
function receiveChatMessage(message) {
  if (!message || message.from === userId || typeof message.text !== "string") return;
  renderChatMessage(message);
}
async function sendChatMessage(event) {
  event.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message || !channel || message.length > 1000) return;
  const payload = { from: userId, name: displayName, avatar: avatarData, text: message, createdAt: Date.now() };
  renderChatMessage(payload);
  input.value = "";
  const result = await channel.send({ type: "broadcast", event: "room-chat", payload });
  if (result !== "ok") toast("Message may not have sent. Check your connection.");
}

function openProfileDialog() {
  pendingAvatar = avatarData;
  $("avatar-file").value = "";
  $("profile-message").textContent = "";
  updateProfilePreview();
  $("profile-dialog").showModal();
}
$("profile-open").addEventListener("click", openProfileDialog);
$("profile-close").addEventListener("click", () => $("profile-dialog").close());
$("avatar-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!["image/png","image/jpeg","image/webp","image/gif"].includes(file.type)) {
    $("profile-message").textContent = "Choose a PNG, JPG, WEBP, or GIF image.";
    event.target.value = ""; return;
  }
  if (file.size > 8 * 1024 * 1024) {
    $("profile-message").textContent = "That image is too large. Choose one under 8 MB.";
    event.target.value = ""; return;
  }
  try {
    const source = await createImageBitmap(file);
    const scale = Math.min(1, 256 / Math.max(source.width, source.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close?.();
    pendingAvatar = canvas.toDataURL("image/webp", 0.78);
    updateProfilePreview();
    $("profile-message").textContent = "Preview updated. Save your profile to apply it.";
  } catch {
    $("profile-message").textContent = "Couldn't read that image. Try a different picture.";
  }
});
$("avatar-remove").addEventListener("click", () => {
  pendingAvatar = "";
  $("avatar-file").value = "";
  updateProfilePreview();
  $("profile-message").textContent = "Picture removed. Save your profile to apply the change.";
});
$("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  avatarData = pendingAvatar;
  try {
    if (avatarData) localStorage.setItem("vc-avatar", avatarData);
    else localStorage.removeItem("vc-avatar");
  } catch {
    $("profile-message").textContent = "This picture couldn't be saved on this device. Try a smaller image.";
    return;
  }
  updateSelfProfileUI();
  if (channel) await trackSelf();
  $("profile-dialog").close();
  toast("Your profile picture was updated.");
});
$("chat-form").addEventListener("submit", sendChatMessage);
$("chat-toggle").addEventListener("click", () => {
  const panel = $("room-chat");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !opening);
  $("chat-toggle").setAttribute("aria-expanded", String(opening));
  $("chat-toggle").textContent = opening ? "Hide chat" : "Chat";
  if (opening) { panel.scrollIntoView({ behavior: "smooth", block: "nearest" }); $("chat-input").focus(); }
});

function syncMembers() {
  if (!channel) return;
  const state = channel.presenceState(), next = new Map();
  for (const [id, entries] of Object.entries(state)) {
    const p = entries[0] || {};
    next.set(id, { id, name: p.name || "Guest", avatar: p.avatar || "", role: p.role || "member", micOn: !!p.micOn });
  }
  members = next;

  // All remaining clients independently calculate the same pseudo-random
  // successor from the live member list, avoiding competing elections.
  const activeOwner = [...members.values()].find(member => member.role === "owner");
  if (ownerElectionTimer) { clearTimeout(ownerElectionTimer); ownerElectionTimer = null; }
  if (activeOwner) {
    if (userId === activeOwner.id) {
      isOwner = true; myRole = "owner";
    } else {
      isOwner = false;
      myRole = members.get(userId)?.role || "member";
    }
    $("self-role").textContent = isOwner ? "Room owner" : myRole === "moderator" ? "Moderator" : "Member";
    $("room-menu-button").classList.toggle("hidden", !isOwner);
  } else if (members.size) {
    ownerElectionTimer = setTimeout(async () => {
      if (!channel || !room) return;
      const stateNow = channel.presenceState();
      const current = Object.entries(stateNow).map(([id, entries]) => ({
        id, role: (entries[0] || {}).role || "member"
      }));
      if (!current.length || current.some(member => member.role === "owner")) return;
      const ids = current.map(member => member.id).sort();
      const seed = room.key + "|" + ids.join("|");
      let hash = 2166136261;
      for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const successor = ids[(hash >>> 0) % ids.length];
      if (successor !== userId) return;
      isOwner = true; myRole = "owner";
      localStorage.setItem("vc-owner-" + room.key, userId);
      $("self-role").textContent = "Room owner";
      $("room-menu-button").classList.remove("hidden");
      await trackSelf();
      toast("The previous owner left. You're the new room owner!");
    }, 1800);
  }

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
    const av = document.createElement("div"); av.className = "avatar"; setAvatar(av, m.avatar, m.name);
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
  renderVoicePeople();
}
function renderVoicePeople() {
  const stage = $("voice-people");
  if (!stage) return;
  stage.replaceChildren();
  for (const m of members.values()) {
    const tile = document.createElement("div");
    tile.className = "voice-person" + (m.micOn ? " speaking" : "");
    const avatar = document.createElement("div");
    avatar.className = "voice-person-avatar";
    setAvatar(avatar, m.avatar, m.name);
    const name = document.createElement("div");
    name.className = "voice-person-name";
    name.textContent = m.name + (m.id === userId ? " (you)" : "");
    tile.append(avatar, name);
    stage.append(tile);
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
  trackSelf();
}
async function handleModeration(p) {
  if (p.target !== userId || p.action !== "mute") return;
  micOn = false;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
  updateMicUI(); await trackSelf();
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
    await trackSelf();
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
    if (!window.isSecureContext) { toast("Screen sharing needs a secure HTTPS page. Open the GitHub Pages link directly."); return; }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") { toast("Screen sharing is not available in this browser. Open VoiceChat in the latest desktop Chrome or Edge; iPhone and iPad browsers do not support sharing a screen here."); return; }
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    const track = screenStream.getVideoTracks()[0];
    if (!track) throw new Error("No screen video track was created.");
    $("screen-video").srcObject = screenStream;
    $("screen-area").classList.remove("hidden");
    $("screen-button").classList.add("active");
    $("screen-button").querySelector("small").textContent = "Stop share";
    for (const pc of peers.values()) {
      const videoTransceiver = pc.getTransceivers().find(t => t.receiver?.track?.kind === "video");
      const sender = videoTransceiver?.sender;
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
    for (const pc of peers.values()) {
      const videoTransceiver = pc.getTransceivers().find(t => t.receiver?.track?.kind === "video");
      const sender = videoTransceiver?.sender;
      if (sender) sender.replaceTrack(null).catch(() => {});
    }
    oldStream.getTracks().forEach(t => t.stop());
  }
  $("screen-video").srcObject = null;
  if (!$("remote-screens").children.length) $("screen-area").classList.add("hidden");
  $("screen-button").classList.remove("active"); $("screen-button").querySelector("small").textContent = "Share screen";
}
$("screen-button").addEventListener("click", () => screenStream ? stopScreen() : shareScreen());
$("stop-screen").addEventListener("click", stopScreen);

async function leaveRoom(returnToLobby = true) {
  if (ownerElectionTimer) { clearTimeout(ownerElectionTimer); ownerElectionTimer = null; }
  stopScreen();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  for (const id of [...peers.keys()]) closePeer(id);
  if (room) await supabase.from("room_sessions").delete().eq("user_id",userId);
  if (channel) { await supabase.removeChannel(channel); channel = null; }
  micOn = false; updateMicUI(); members.clear(); $("chat-messages").innerHTML = ""; $("chat-empty").classList.remove("hidden"); room = null;
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
