FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/video
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY src ./src

# The workflow mounts the repository read-only at /workspace and a bounded
# output directory at /output. Run custom scene code only in that isolated
# container, with --network none, no secrets, and the resource limits in CI.
USER node
ENV VIDEO_REPO_ROOT=/workspace
ENTRYPOINT ["node", "/opt/video/src/render.mjs"]
