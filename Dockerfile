FROM node:22-bookworm-slim

# ffmpeg (provides both ffmpeg and ffprobe) is required for video rendering.
# Installed via apt so the binaries land in /usr/bin, always on PATH at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

CMD ["npm", "start"]
