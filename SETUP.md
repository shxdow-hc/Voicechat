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

## 3. Enable username/password accounts

Run the latest full SQL in `supabase-auth.sql` in the Supabase **SQL Editor** (run it again if you already ran the earlier version). It creates the profiles table, enforces case-insensitive unique usernames, and adds a database-backed one-active-session lock per account.

Then open **Authentication → Providers → Email** and turn **Confirm email OFF**. This app uses username/password accounts rather than collecting email addresses, so email confirmation cannot be completed. Keep password security enabled. The app maps each username to an internal, non-deliverable email address for Supabase Auth; users only enter their username and password.

After the SQL and Auth setting are in place, new visitors see **Log in** and **Register**. Registration checks that both password entries match, requires at least 8 characters, and the database rejects usernames that are already taken (including capitalization variants). After registration, the user is returned to the login screen and must log in. Each account can be active in only one browser tab/device at a time. A second login is rejected while the first session is active; if a browser crashes or loses connection without releasing its lock, it expires after about 90 seconds. Users can use the **Log out** button to end their session.

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
