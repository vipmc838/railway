FROM node:20-alpine3.20

WORKDIR /app
COPY index.js package.json ./

EXPOSE 3000

RUN apk update && apk add --no-cache bash openssl curl \
    build-base python3 libffi-dev \
    && npm install \
    && apk del build-base python3 libffi-dev   # 可选，清理构建工具

CMD ["node", "index.js"]
