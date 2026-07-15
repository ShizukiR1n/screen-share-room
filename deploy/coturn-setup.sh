#!/bin/bash
# 聚幕自建 TURN 中继一键安装脚本（Ubuntu / Debian）
# 用法: bash coturn-setup.sh <服务器公网IP>
# 或:   curl -fsSL https://cdn.jsdelivr.net/gh/ShizukiR1n/screen-share-room@main/deploy/coturn-setup.sh | bash -s -- <服务器公网IP>
set -e

PUBIP="$1"
if [ -z "$PUBIP" ]; then
  echo "用法: bash coturn-setup.sh <服务器公网IP>"
  exit 1
fi

PRIVIP=$(hostname -I | awk '{print $1}')
SECRET=$(openssl rand -hex 24)

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y coturn

cat > /etc/turnserver.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
# 云服务器公网 IP 是 NAT 映射的，必须声明公网/内网对应关系
external-ip=${PUBIP}/${PRIVIP}
# 中继端口范围（需在云控制台防火墙同步放行 UDP 50000-50200）
min-port=50000
max-port=50200
# 临时凭据模式：与网页服务器共享同一个密钥，凭据 12 小时过期
use-auth-secret
static-auth-secret=${SECRET}
realm=jumu.relay
fingerprint
no-cli
no-multicast-peers
# 禁止把流量中继到内网地址（安全加固）
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
# 并发配额（3 人房间足够，防滥用）
total-quota=16
user-quota=8
syslog
EOF

echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 1

# iptables 持久化工具（443/udp 已归 OBS 推流服务使用，见 mediamtx-setup.sh）
echo 'iptables-persistent iptables-persistent/autosave_v4 boolean true' | debconf-set-selections
echo 'iptables-persistent iptables-persistent/autosave_v6 boolean true' | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null 2>&1
netfilter-persistent save >/dev/null 2>&1

if systemctl is-active --quiet coturn; then
  echo
  echo "=================================================="
  echo "✅ 中继服务安装并启动成功！"
  echo "请把下面两行完整复制发给 Claude："
  echo
  echo "TURN_HOST=${PUBIP}"
  echo "TURN_SECRET=${SECRET}"
  echo "=================================================="
else
  echo "❌ coturn 启动失败，请把以下日志发给 Claude："
  journalctl -u coturn --no-pager -n 30
  exit 1
fi
