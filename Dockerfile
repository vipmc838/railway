FROM alpine:latest

# 1. 安裝系統依賴及最新版 Hysteria 2
RUN apk add --no-cache ca-certificates curl bash openssl \
    && curl -Lo /usr/local/bin/hysteria https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-amd64 \
    && chmod +x /usr/local/bin/hysteria

# 2. 建立配置目錄
RUN mkdir -p /etc/hysteria

# 3. 寫入 Hysteria 2 服務端設定檔
# Back4app 容器默認會分配一個動態端口，我們監聽 8080 端口，Back4app 會自動幫我們對外映射
RUN echo -e 'listen: :8080\nacme:\n  disable: true\ntls:\n  cert: /etc/hysteria/server.crt\n  key: /etc/hysteria/server.key\nauth:\n  type: password\n  password: "Ronald9988"' > /etc/hysteria/config.yaml

# 4. 寫入啟動腳本 (自動生成自簽憑證並啟動)
RUN echo -e '#!/bin/bash\n\
openssl req -newkey rsa:2048 -nodes -keyout /etc/hysteria/server.key -x509 -days 3650 -out /etc/hysteria/server.crt -subj "/CN=localhost"\n\
exec /usr/local/bin/hysteria server --config /etc/hysteria/config.yaml\n\
' > /entrypoint.sh && chmod +x /entrypoint.sh

# 5. 暴露 8080 端口
EXPOSE 8080

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
