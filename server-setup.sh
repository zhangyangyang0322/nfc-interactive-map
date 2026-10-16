#!/usr/bin/env bash
# NFC 碰一碰 · 云服务器一键部署（Ubuntu 22.04）
# 安装 Node + server.js + Nginx(HTTP/WS)，HTTPS 待配置域名后叠加
set -e

echo "=== 1/6 更新系统并安装基础包 ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx curl ca-certificates gnupg

echo "=== 2/6 安装 Node.js 20 ==="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "=== 3/6 下载并部署 server.js ==="
mkdir -p /opt/nfc-map
cd /opt/nfc-map
curl -fsSL -o server.js https://raw.githubusercontent.com/zhangyangyang0322/nfc-interactive-map/main/server.js
curl -fsSL -o package.json https://raw.githubusercontent.com/zhangyangyang0322/nfc-interactive-map/main/package.json
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund >/dev/null 2>&1 || npm install ws --no-audit --no-fund >/dev/null 2>&1
fi

echo "=== 4/6 注册 systemd 服务（开机自启）==="
cat > /etc/systemd/system/nfc-map.service <<'EOF'
[Unit]
Description=NFC Map backend
After=network.target
[Service]
WorkingDirectory=/opt/nfc-map
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable nfc-map
systemctl restart nfc-map

echo "=== 5/6 配置 Nginx 反向代理（HTTP/WS -> 3000）==="
cat > /etc/nginx/sites-available/nfc-map <<'EOF'
server {
  listen 80 default_server;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
  }
}
EOF
ln -sf /etc/nginx/sites-available/nfc-map /etc/nginx/sites-enabled/nfc-map
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== 6/6 验证 ==="
sleep 1
echo "node: $(node -v)"
echo "服务状态: $(systemctl is-active nfc-map)"
echo "后端健康: $(curl -s http://127.0.0.1:3000/health)"
echo ""
echo "================ 部署完成 ================"
echo "后台看板(内网验证): http://47.76.149.142/admin"
echo "HTTPS/WSS 需配置域名后叠加，下一步我继续帮你"
