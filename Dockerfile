FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Install curl for healthcheck, create data/assets dirs, set ownership
RUN apk add --no-cache curl \
  && mkdir -p /app/data /app/public/Assets \
  && chown -R node:node /app/data /app/public/Assets

USER node

VOLUME /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:$PORT/health || exit 1

CMD ["npm", "start"]
