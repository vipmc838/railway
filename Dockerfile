FROM node:20-bookworm-slim

WORKDIR /app
COPY index.js package.json ./

EXPOSE 3000

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash openssl curl ca-certificates && \
    npm install && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

CMD ["node", "index.js"]
