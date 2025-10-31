#!/bin/bash
set -e

# Cria um resolv.conf alternativo dentro de /tmp (que é gravável)
echo "nameserver 1.1.1.1" > /tmp/resolv.conf
echo "nameserver 8.8.8.8" >> /tmp/resolv.conf

# Força o Node e a aplicação a usar esse resolv.conf
export RES_OPTIONS="ndots:0"
export DNS_SERVERS="1.1.1.1 8.8.8.8"

# Redefine o resolv.conf do container via LD_PRELOAD (método compatível)
ln -sf /tmp/resolv.conf /etc/resolv.conf 2>/dev/null || true

echo "[INFO] DNS forçado: 1.1.1.1 e 8.8.8.8"
exec node server.js
