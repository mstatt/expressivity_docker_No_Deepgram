# syntax=docker/dockerfile:1
# Expressivity demo in one image: the built page and the Pipecat bot, behind one port (9940).

# ---- 1. Build the page -------------------------------------------------------
FROM node:22-bookworm-slim AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
# npm ci installs exactly what the lockfile pins.
RUN npm ci --no-audit --no-fund
COPY client/ ./
# "smallwebrtc" (default, no account needed) or "daily". Baked into the page at build time.
ARG VITE_TRANSPORT=smallwebrtc
ENV VITE_TRANSPORT=${VITE_TRANSPORT}
RUN npm run build

# ---- 2. The bot, plus nginx to serve the page and proxy /api to the bot -------
FROM python:3.13-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app \
    && mkdir -p /app /opt/hf \
    && chown -R app:app /app /opt/hf

USER app
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    HF_HOME=/opt/hf \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}"

# Dependencies. Upstream ships no uv.lock, so this resolves at build time.
COPY --chown=app:app server/pyproject.toml server/.python-version ./
RUN uv sync --no-install-project --no-dev --no-cache

# The two models, downloaded into the image so the first session doesn't wait for them.
RUN python -c "\
from pipecat.classifiers.tone.model import PipecatToneReaderModel; \
from pipecat.classifiers.voice.model import PipecatVoiceReaderModel; \
PipecatToneReaderModel.download(); PipecatVoiceReaderModel.download()"

COPY --chown=app:app server/bot.py server/clips.py server/conclusion.py server/transcripts.py server/docker_webrtc.py ./
COPY --chown=app:app server/clips ./clips
COPY --from=client /client/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 9940
# Run through sh so the script works even if its executable bit was lost on extraction.
ENTRYPOINT ["sh", "/usr/local/bin/entrypoint.sh"]
