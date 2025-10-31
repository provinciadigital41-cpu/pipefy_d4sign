#!/bin/bash

# --- CORREÇÃO DE DNS (Deve ser o primeiro comando) ---
# Sobrescreve o arquivo de configuração de DNS dentro do contêiner.
# Usamos 8.8.8.8 (Google) e 1.1.1.1 (Cloudflare) como garantia.
echo -e "nameserver 8.8.8.8\nnameserver 1.1.1.1" > /etc/resolv.conf

# O comando 'exec "$@"' garante que o comando principal (CMD)
# seja executado, substituindo o processo do entrypoint.
exec "$@"
