FROM node:18-alpine
RUN apk add --no-cache bash curl iputils
WORKDIR /app
RUN echo "nameserver 1.1.1.1" > /etc/resolv.conf && echo "nameserver 8.8.8.8" >> /etc/resolv.conf
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
