# Production Dockerfile for AnonKonnect
#
# Render/hosts sometimes run only `npm start`, so we ensure `.next` is generated
# during the Docker image build (via `npm run build`) before starting the server.
FROM node:20-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm install

# Copy the whole project (Next.js build needs app/components/lib/prisma/etc.)
COPY . .

# Generate Prisma client (if needed) and build Next.js to produce `.next`
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server/server.js"]
