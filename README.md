# Vortex Pair Code Generator

A lightweight web app that generates a WhatsApp pairing code and sends the resulting session payload to the paired WhatsApp number for use with the Vortex bot.

## How it works

1. You open the site and enter your WhatsApp phone number (with country code).
2. The server spins up a temporary [Baileys](https://github.com/WhiskeySockets/Baileys) socket and calls `requestPairingCode()`.
3. An 8-digit code appears on the site.
4. You open WhatsApp → **Settings → Linked Devices → Link a Device → Link with phone number instead**, and type the code.
5. Once linked, the server gzips + base64-encodes `creds.json` into a string of the form `Vortex!<base64>...` and sends it to the paired number.
6. The message is then used as the `SESSION_ID` value for your Vortex deployment.

## GitHub

- Project profile: https://github.com/mxgamecoder
- Repo: https://github.com/mxgamecoder/vortex-pair-site
- pair code link: https://vortex-pair-site.lumorapp.name.ng
- for more info vist https://lumorapp.app

## Local development

```bash
npm install
npm start
# open http://localhost:3000
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/api/pair/request` | Body `{ phone }` → starts a session |
| GET | `/api/pair/status` | `?sessionId=` → code + session string |
| POST | `/api/pair/cancel` | `?sessionId=` → abort a session |
| GET | `/api/deploy/render` | Returns a Render YAML for the bot |

## Session ID format

```
Vortex!<base64-of-gzipped-creds.json>...
```

## Notes

- Pairing sessions auto-expire after **6 minutes** and auth folders are cleaned from `/tmp`.
- The free Render plan sleeps after inactivity; the first request after sleep takes ~30s to wake.
