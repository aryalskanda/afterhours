# The Linux build, end to end, in a container: a virtual screen (Xvfb), the libraries Electron
# needs, and Bun for the test. No keyring, so it also covers the app's no-keyring path.
#   docker build -f e2e/linux.Dockerfile -t afterhours-desktop-e2e e2e
#   docker run --rm --shm-size=1g -v "$REPO:/repo:ro" -v "$OUT:/out" -w /repo/apps/desktop \
#     -e ELECTRON_APP=/repo/apps/desktop/release/linux-arm64-unpacked/afterhours \
#     -e ELECTRON_EXTRA_ARGS=--no-sandbox -e E2E_OUT=/out -e DISPLAY=:99 afterhours-desktop-e2e \
#     sh -c 'Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp & sleep 1; bun e2e/desktop.e2e.ts'
# (Xvfb directly: xvfb-run waits forever for its start signal in a container.)
FROM oven/bun:1.3.3
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb fonts-dejavu-core \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libatk-bridge2.0-0 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxtst6 libcups2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*
