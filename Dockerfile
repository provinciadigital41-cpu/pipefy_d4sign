# Usa imagem Debian, mais estável para rede e build
FROM node:18-bullseye

# Define o diretório de trabalho
WORKDIR /app

# Instala utilitários básicos
RUN apt-get update && apt-get install -y bash curl iputils-ping && rm -rf /var/lib/apt/lists/*

# Copia os arquivos de dependências
COPY package*.json ./
RUN npm install

# Copia o código da aplicação
COPY . .

# Expõe a porta padrão da aplicação
EXPOSE 3000

# Define DNS preferencial via variável (modo compatível com Hostinger)
ENV DNS_SERVERS="1.1.1.1 8.8.8.8"

# Inicia o app Node
CMD echo 'nameserver 1.1.1.1\nnameserver 8.8.8.8' > /etc/resolv.conf 2>/dev/null || true && node server.js
