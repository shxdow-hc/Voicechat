# VoiceChat setup

The GitHub Pages site is the frontend only. Live rooms need a Supabase project for realtime signaling; WebRTC then carries the audio and screen-share streams directly between browsers. This first version is a small-room prototype, not a production voice service.

## 1. Create a Supabase project

1. Create a project at https://supabase.com/.
2. Open **Project Settings → API**.
3. Copy the **Project URL** and the **anon / publishable key**.
4. In this repository, open `app.js` and replace:
   - `YOUR_SUPABASE_PROJECT_URL`
   - `YOUR_SUPABASE_ANON_KEY`
5. Commit the change. The anon key is intended for browser use; never put a service-role key in frontend code.

## 2. Enable Realtime

In Supabase, open **Database → Replication** or **Realtime** settings and make sure Realtime is enabled for your project. This prototype uses Supabase Realtime channels with presence and broadcast. The room channel is public so browsers can exchange WebRTC signaling messages.

## 3. Enable password-free guest access

In Supabase, open **Authentication → Sign In / Providers** (the exact menu label may vary) and enable **Anonymous Sign-Ins**. This lets the site create a temporary guest identity automatically; visitors do not enter an email, username, or password and do not register accounts.

Run the latest full SQL in `supabase-auth.sql` in the Supabase **SQL Editor** so the room-presence table and its policies are installed. The app uses each temporary guest identity only to authorize that visitor’s own room-presence record. Display names and profile pictures are stored in that browser and can be changed with **Edit profile**. A fresh guest identity is created each time the site is opened; there is no account login or account logout.

## 4. Publish with GitHub Pages

In GitHub, open **Settings → Pages** and select **Deploy from a branch**, branch **main**, folder **/(root)**. Save and wait for the Pages deployment to finish.

Your site will be:

`https://andakeevamir010-cyber.github.io/Voicechat/`

## 5. Try it

- Open the site in a modern browser over HTTPS.
- Create a room with a name and private code.
- On another device/browser, enter the same room name and code.
- Allow microphone access, then choose **Unmute**.
- Choose **Share screen** to share a screen or browser tab. The browser controls which screen is shared.

## Important prototype limitations

- This is a peer-to-peer mesh prototype intended for a few participants. Larger rooms need an SFU media server (for example LiveKit) and TURN infrastructure for reliable connectivity.
- Current owner/moderator actions are UI-level broadcast actions. They are **not securely enforced by a trusted server** yet; a determined participant could spoof them. Do not use this for sensitive/private meetings until server-side authentication, room records, and role checks are added.
- Room names and codes are used to derive the realtime channel name. Use a unique, hard-to-guess code; do not reuse passwords.
- Screen sharing depends on browser support and user permission. Some mobile browsers do not support display capture.
- The app does not record audio or screen shares.

## Roadmap

1. Add a trusted server-side room/role layer (database policies or server functions).
2. Add TURN/SFU infrastructure for reliable group calls.
3. Add authenticated display names, room expiry, and stronger invite handling.
4. Add accessible device selection and moderator/owner management UI.


## Account notes

- Username uniqueness is enforced by the database, not just by a browser-side check.
- Usernames are 3–20 characters and may contain letters, numbers, and underscores.
- Passwords are handled by Supabase Auth; the app does not store passwords in local storage.
- The publishable Supabase key in the frontend is expected. Never expose a service-role key.

## 6. Private platform owner dashboard

The dashboard is hidden unless the signed-in account has a row in `platform_admins`. After the owner confirms their exact registered username, run the one-time SQL statement at the bottom of `supabase-auth.sql` with that username. Do not add any other account. The dashboard lists registered usernames, account creation dates, online/offline state, active room names/codes, and room members. The owner can join or close an active room, suspend/unsuspend an account, and revoke an account session. Suspended users are blocked at login. It never exposes passwords. Room activity expires after 90 seconds without a heartbeat. Run the complete latest SQL file again after each dashboard schema update.
