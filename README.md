# VoiceChat

A dark purple voice-room website built for GitHub Pages.

## What's included

- Create-room and join-room screens with room name + access code
- Responsive desktop, tablet, and mobile interface
- Room member list and role labels
- Microphone mute/unmute controls
- Initial peer-to-peer WebRTC audio and screen-share prototype
- Owner close-room and moderator mute controls

## Getting started

1. Follow **[SETUP.md](./SETUP.md)** to connect a Supabase project.
2. Enable GitHub Pages from the `main` branch and the repository root.
3. Open the published site over HTTPS.

## Current status

The frontend has been committed. Live rooms require Supabase configuration. This is an early prototype for small groups: owner/moderator permissions are not yet securely enforced by a trusted server, and reliable larger calls need TURN/SFU media infrastructure. Do not use it for sensitive meetings yet.

See [SETUP.md](./SETUP.md) for configuration and limitations.
