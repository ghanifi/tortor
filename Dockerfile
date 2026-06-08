# Dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p logs

EXPOSE 3000

CMD ["sh", "-c", "node src/ui/server.js & node src/index.js 2>&1 | tee -a logs/bot.log"]
