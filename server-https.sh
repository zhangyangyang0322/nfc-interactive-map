#!/usr/bin/env bash
# NFC 碰一碰 · HTTPS/WSS 配置（Let's Encrypt 免费证书）
# 为 dayunhemiaohui.me 签发证书 + Nginx 配置 HTTPS/WSS 反代
set -e
DOMAIN="dayunhemiaohui.me"
EMAIL="admin@dayunhemiaohui.me"
WWW="/opt/nfc-map/www"

echo "=== 1/5 安装 certbot ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y certbot

echo "=== 2/5 配置 HTTP 站点(webroot 验证 + 反代) ==="
mkdir -p $WWW
cat > /etc/nginx/sites-available/nfc-map <<'EOF'
server {
  listen 80;
  server_name dayunhemiaohui.me www.dayunhemiaohui.me;
  location /.well-known/acme-challenge/ { root /opt/nfc-map/www; }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 600s;
  }
}
EOF
nginx -t && systemctl reload nginx

echo "=== 3/5 申请 Let's Encrypt 免费证书 ==="
certbot certonly --webroot -w $WWW -d $DOMAIN -d www.$DOMAIN \
  --agree-tos -m $EMAIL --no-eff-email --non-interactive

echo "=== 4/5 配置 Nginx HTTPS/WSS ==="
cat > /etc/nginx/sites-available/nfc-map <<'EOF'
server {
  listen 80;
  server_name dayunhemiaohui.me www.dayunhemiaohui.me;
  location /.well-known/acme-challenge/ { root /opt/nfc-map/www; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl;
  http2 on;
  server_name dayunhemiaohui.me www.dayunhemiaohui.me;
  ssl_certificate /etc/letsencrypt/live/dayunhemiaohui.me/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dayunhemiaohui.me/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
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
nginx -t && systemctl reload nginx

echo "=== 5/5 自动续期 + 验证 ==="
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true
sleep 1
echo "HTTPS 验证: $(curl -sk https://localhost/health)"
echo "证书有效期:"
certbot certificates 2>/dev/null | grep -E "Domains|Expiry" | head
echo ""
echo "================ HTTPS 配置完成 ================"
echo "正式地址: https://$DOMAIN"
