# Production Dockerfile for AnonKonnect Signaling Server
FROM node:20-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm install --production

# Copy server and public assets
COPY server/ ./server/
COPY public/ ./public/

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server/server.js"]
