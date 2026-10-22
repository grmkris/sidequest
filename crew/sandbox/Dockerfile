# sidequest-crew: the image every crew bot runs in (`crew.ts up`, one always-on container per member). Its supervisor,
# bun running crew.ts, starts as root to keep the member's OAuth files out of the harness's reach and drops each run to
# `agent` (uid 1000) with setpriv. The harness CLIs (codex, grok), Foundry and the harness's bun are mounted read-only
# from the host (same versions as the host); this image carries the OS, the supervisor's bun, node for npx tools
# (wrangler, hyperframes), the system libraries of Playwright's Chromium and WebKit for headless rendering and browser
# tests, git, python, ffmpeg, and OpenSCAD with a virtual display (xvfb-run) for 3D-printable models and their previews.
FROM oven/bun:1.4.2 AS bun
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 python3-pip ripgrep ffmpeg unzip xz-utils openscad xvfb xauth \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libudev1 fonts-dejavu-core \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
# WebKit is Safari's engine: with it a member tests web work as iPhone Safari as well as Android Chrome. A run drops to
# uid 1000 and cannot apt-get, so the libraries live here; each run still downloads the browser build its project's
# Playwright wants. The version matches the repository's playwright-core pin.
RUN npx -y playwright@1.63.0 install-deps chromium webkit && rm -rf /var/lib/apt/lists/*
# the host's uid, so files in mounted directories stay owned by the host user
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash agent
COPY sq-deliver /usr/local/bin/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# A run on the host (`crew.ts run` outside a container) uses this user; a bot's container starts as root instead.
USER agent
WORKDIR /crew/agent
