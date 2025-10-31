#!/bin/bash
set -e

# Força o DNS para Cloudflare e Google antes de iniciar o Node
echo "nameserver 1.1.1.1" > /etc/resolv.conf
echo "nameserver 8.8.8.8" >> /etc/resolv.conf

echo "[INFO] DNS configurado manualmente para 1.1.1.1 e 8.8.8.8"
echo "[INFO] Iniciando aplicação Node..."

# Executa o servidor Node normalmente
exec node server.js
