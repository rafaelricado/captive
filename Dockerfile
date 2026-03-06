FROM node:20-alpine

# Dependências nativas (ping para pingService.js)
RUN apk add --no-cache iputils

WORKDIR /app

# Instala dependências antes de copiar o restante para aproveitar o cache de camadas
COPY package.json ./
RUN npm install --omit=dev

# Copia o código da aplicação (node_modules excluído via .dockerignore)
COPY . .

# Cria diretórios necessários em runtime
RUN mkdir -p logs public/uploads/logo

EXPOSE 3000

# Graceful shutdown: usa exec para que SIGTERM chegue ao node, não ao sh
CMD ["node", "server.js"]
