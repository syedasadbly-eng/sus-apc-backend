FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production

COPY server.js ./

# Create data directory for persistent SQLite database
RUN mkdir -p /data

ENV PORT=3001
ENV DB_PATH=/data/apc_data.db

EXPOSE 3001

CMD ["node", "server.js"]
