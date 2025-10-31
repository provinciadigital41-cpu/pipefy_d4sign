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

RUN chmod +x ./entrypoint.sh

# Expõe a porta padrão da aplicação
EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]

# Apenas define o comando principal
CMD ["node", "server.js"]
