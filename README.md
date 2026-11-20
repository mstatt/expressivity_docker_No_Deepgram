# Expressivity, in Docker on port 9940

A packaging of [pipecat-examples/expressivity](https://github.com/pipecat-ai/pipecat-examples/tree/main/expressivity)
(commit `6f389d5`, 2026-11-19) as one container, changed so that **Google Chrome transcribes the
speech** in place of Deepgram. No API key is needed. The upstream README is `README.upstream.md`
(it still describes the Deepgram version).

## Run

```bash
docker compose up --build
```

Then open <http://localhost:9940> **in Google Chrome (version 139 or later)**. Press **Play** for
the premade clips or **Mic** for your microphone.

The first build takes several minutes: it installs the dependencies and downloads the two models.
Stop with `Ctrl+C`, or `docker compose down`.

## How the words are transcribed now

- The page runs Chrome's built-in speech recognition (the Web Speech API) on the same audio the bot
  hears: the clip being played, or your microphone.
- When the bot reports that a turn stopped, the page sends that turn's words to the bot, which
  feeds them to Tone Reader where Deepgram's transcript used to go.
- **Where the audio goes:** Chrome sends it to Google's speech service by default. If Chrome's
  on-device English speech model is already installed, the page uses that and nothing leaves the machine.
- Other browsers (Firefox, Safari, any browser on iPhone/iPad) can't do this. The page says so, and
  shows the Voice Reader's side only when there are no words.

## If the page stays on "Connecting"

The audio travels peer-to-peer over UDP between your browser and the container. So that this works
under Docker Desktop (Windows, macOS) as well as on Linux, the container's UDP ports 40000-40099 are
published on `127.0.0.1`, and the bot tells the browser to use that address (`server/docker_webrtc.py`).

If it still doesn't connect:

1. In `.env`, set `WEBRTC_HOST_IP` to this computer's own network address (for example
   `192.168.1.20`; run `ipconfig` on Windows or `ifconfig` on macOS/Linux), then
   `docker compose up` again. The audio ports are then published on that address instead.
2. If Docker reports that a port in 40000-40099 is unavailable, something else is using it: change
   the range in both places in `docker-compose.yml`.
3. As a last resort, `TRANSPORT=daily` with a `DAILY_API_KEY` relays the audio through Daily's
   cloud (needs `docker compose up --build`).

## Phones

The layout is mobile-first (stacked below 1024px wide, 44px touch targets, sized to the visible
screen). This packaging adds safe-area padding for notches and a scrolling layout for a phone held
sideways.

Opening it *from* a phone takes more than layout, though:

- The port is bound to `127.0.0.1`, so only this computer can reach it.
- Browsers allow the microphone and speech recognition only on `localhost` or HTTPS, so a phone
  needs the page served over HTTPS (for example through a tunnel or a reverse proxy with a certificate).
- Set `WEBRTC_HOST_IP` to this computer's network address so the phone can reach the audio ports,
  or use `TRANSPORT=daily`.
- Transcription needs Chrome on Android. Browsers on iPhone can't do it.

## What changed from upstream

| File | Change |
| --- | --- |
| `server/transcripts.py` | New. Takes the STT service's place and turns the page's `transcript` messages into transcriptions. |
| `server/bot.py` | Deepgram removed; `BrowserTranscripts` added to the pipeline; handles the `transcript` message. |
| `server/docker_webrtc.py` | New. Has the bot offer the browser an address it can reach from outside the container. |
| `server/pyproject.toml`, `server/env.example` | Deepgram dependency and key removed. |
| `client/src/lib/browser-transcription.ts` | New. Runs Chrome's speech recognition on the track the bot hears. |
| `client/src/hooks/use-browser-transcription.ts` | New. Wires it to the session and sends each turn's words. |
| `client/src/app.tsx` | Mounts the hook. |
| `client/src/index.css` | Safe-area padding; scrolling layout for short, narrow screens. |

## Docker files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Stage 1 builds the page with Node 22 (`npm ci`, `npm run build`). Stage 2 installs the bot with `uv` on Python 3.13, bakes in the models, and adds nginx. |
| `docker/nginx.conf` | Serves the page on 9940 and proxies `/api/*` to the bot, as `client/vite.config.ts` does in development. |
| `docker/entrypoint.sh` | Starts the bot (on 127.0.0.1:7860, inside the container only) and nginx. |
| `docker-compose.yml` | Publishes `127.0.0.1:9940` and passes the settings from `.env`. |

Notes:

- The demo has no authentication, which is why the port is local-only.
- The container runs as a non-root user.
- Upstream has no `uv.lock`, so Python dependencies resolve to the newest matching versions at build
  time (`pipecat-ai>=1.16.0`). npm dependencies are pinned by `client/package-lock.json`.
- To use a different host port, change the left side of `"127.0.0.1:9940:9940"`.
