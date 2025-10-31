# Usa imagem Debian completa, mais compatível com VPS e EasyPanel
FROM node:18-bullseye

# Define o diretório de trabalho
WORKDIR /app

# Instala utilitários de rede e shell
RUN apt-get update && apt-get install -y bash curl iputils-ping && rm -rf /var/lib/apt/lists/*

# Corrige DNS dentro do container
RUN echo "nameserver 1.1.1.1" > /etc/resolv.conf && echo "nameserver 8.8.8.8" >> /etc/resolv.conf

# Copia os arquivos de dependência e instala pacotes
COPY package*.json ./
RUN npm install

# Copia o código da aplicação
COPY . .

# Expõe a porta 3000
EXPOSE 3000

# Inicia o servidor Node
CMD ["node", "server.js"]
