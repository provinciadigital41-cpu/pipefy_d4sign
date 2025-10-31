#!/bin/bash

# --- CORREÇÃO DE DNS ---
# Garante que o arquivo de DNS do contêiner seja sobrescrito corretamente.
# Usa Cloudflare (1.1.1.1) e Google (8.8.8.8).
echo -e "nameserver 1.1.1.1\nnameserver 8.8.8.8" > /etc/resolv.conf

# Aguarda 2 segundos para evitar problemas de timing no DNS
sleep 2

# Teste básico de resolução DNS antes de iniciar o app (opcional, mas útil para debug)
ping -c 1 api.d4sign.com.br >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "[AVISO] DNS ainda não resolveu api.d4sign.com.br — continuando mesmo assim."
else
  echo "[OK] DNS está resolvendo normalmente."
fi

# Executa o comando principal do container
exec "$@"
