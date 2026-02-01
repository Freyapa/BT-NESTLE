FROM node:20-bullseye-slim

# Install dependencies for Voice & FFmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --production --no-audit

# Copy the rest of the application code
COPY . .

# Create a non-root user for security
RUN groupadd -r nestle && useradd -r -g nestle -G audio,video nestle \
    && chown -R nestle:nestle /app

USER nestle

EXPOSE 8080

CMD ["node", "index.js"]
