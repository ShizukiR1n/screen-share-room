#!/bin/bash
# Beam OBS 推流服务（MediaMTX）一键安装脚本（Ubuntu / Debian）
# 用法: bash mediamtx-setup.sh <服务器公网IP>
#
# 作用：
#   - 安装 MediaMTX（收 OBS 的 WHIP 推流，供网页端 WHEP 拉流）
#   - WebRTC 媒体走 443/udp（QUIC 端口，绕开校园/公司网对杂牌端口 UDP 的限速）
#   - iptables 把 8189/udp 转发到 443 作备用入口（个别网络反而出不去 443/udp）
#   - 撤掉旧的 443/udp -> 3478 转发（coturn 中继回到标准 3478 端口）
# 需在云控制台防火墙放行：TCP 8889、UDP 443、UDP 8189
set -e

PUBIP="$1"
if [ -z "$PUBIP" ]; then
  echo "用法: bash mediamtx-setup.sh <服务器公网IP>"
  exit 1
fi

MTX_VERSION=v1.12.3
PUBPASS=$(openssl rand -hex 16)
READPASS=$(openssl rand -hex 16)

# 下载（GitHub 直连失败时换镜像）
cd /tmp
rm -f mediamtx.tar.gz
ok=""
for base in \
  "https://github.com/bluenviron/mediamtx/releases/download" \
  "https://ghproxy.net/https://github.com/bluenviron/mediamtx/releases/download" \
  "https://gh-proxy.com/https://github.com/bluenviron/mediamtx/releases/download"; do
  if curl -fsSL --connect-timeout 10 -o mediamtx.tar.gz \
    "$base/${MTX_VERSION}/mediamtx_${MTX_VERSION}_linux_amd64.tar.gz"; then
    ok=1; break
  fi
done
if [ -z "$ok" ]; then
  echo "❌ 下载 MediaMTX 失败（GitHub 与镜像均不可达），请把此信息发给 Claude"
  exit 1
fi

mkdir -p /opt/mediamtx
tar xzf mediamtx.tar.gz -C /opt/mediamtx mediamtx

cat > /opt/mediamtx/mediamtx.yml <<EOF
logLevel: info

# 只开 WebRTC（WHIP 推流 / WHEP 拉流），其余协议全关
rtsp: no
rtmp: no
hls: no
srt: no
webrtc: yes
api: no
metrics: no
playback: no

# WHIP/WHEP 的 HTTP 信令端口（由网页服务器代理访问，不加密；媒体本身是 SRTP 加密的）
webrtcAddress: :8889
webrtcEncryption: no
webrtcAllowOrigin: '*'

# 媒体走单一 UDP 端口 443（QUIC 端口，校园/公司网不敢限速）
webrtcLocalUDPAddress: :443
webrtcLocalTCPAddress:
# 只对外公布公网地址（内网地址浏览器连不上，白白拖慢连接）
webrtcIPsFromInterfaces: no
webrtcAdditionalHosts: [${PUBIP}]

# 推流与拉流分别用独立密码（凭据由网页服务器代理注入，不暴露给观众）
authInternalUsers:
- user: publisher
  pass: ${PUBPASS}
  permissions:
  - action: publish
- user: viewer
  pass: ${READPASS}
  permissions:
  - action: read

paths:
  beam: {}
EOF

cat > /etc/systemd/system/mediamtx.service <<'EOF'
[Unit]
Description=MediaMTX (Beam OBS ingest)
After=network.target

[Service]
ExecStart=/opt/mediamtx/mediamtx /opt/mediamtx/mediamtx.yml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# 撤掉旧的 443/udp -> coturn 转发（443 现在归 MediaMTX 直接监听）
iptables -t nat -D PREROUTING -p udp --dport 443 -j REDIRECT --to-ports 3478 2>/dev/null || true
# 备用入口：8189/udp -> 443（个别网络出不去 443/udp 时走这里）
iptables -t nat -C PREROUTING -p udp --dport 8189 -j REDIRECT --to-ports 443 2>/dev/null \
  || iptables -t nat -A PREROUTING -p udp --dport 8189 -j REDIRECT --to-ports 443
netfilter-persistent save >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable mediamtx >/dev/null 2>&1
systemctl restart mediamtx
sleep 2

if systemctl is-active --quiet mediamtx; then
  echo
  echo "=================================================="
  echo "✅ OBS 推流服务安装并启动成功！"
  echo "请把下面两行完整复制发给 Claude："
  echo
  echo "MTX_PUBLISH_PASS=${PUBPASS}"
  echo "MTX_READ_PASS=${READPASS}"
  echo "=================================================="
else
  echo "❌ MediaMTX 启动失败，请把以下日志发给 Claude："
  journalctl -u mediamtx --no-pager -n 30
  exit 1
fi
