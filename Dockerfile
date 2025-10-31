# Base Debian estável, compatível com HTTPS e ferramentas de rede
FROM node:18-bullseye

# Diretório de trabalho dentro do container
WORKDIR /app

# Pacotes úteis para debug e HTTPS
RUN apt-get update \
  && apt-get install -y bash curl iputils-ping ca-certificates libcurl4-openssl-dev \
  && rm -rf /var/lib/apt/lists/*

# Dependências do Node
COPY package*.json ./
# usa npm ci se existir package-lock, senão cai para npm install
RUN npm ci --only=production || npm install --production

# Copia o restante do projeto
COPY . .

# Garante permissão de execução do entrypoint
RUN chmod +x ./entrypoint.sh

# Porta interna da aplicação
EXPOSE 3000

# Executa o seu entrypoint que ajusta o DNS e chama o CMD
ENTRYPOINT ["./entrypoint.sh"]

# Comando principal da aplicação
CMD ["node", "server.js"]
