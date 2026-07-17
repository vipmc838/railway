FROM node:20-bookworm-slim

WORKDIR /app
COPY index.js package.json ./

EXPOSE 8080

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash openssl curl ca-certificates procps && \
    npm install && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

CMD ["node", "index.js"]
