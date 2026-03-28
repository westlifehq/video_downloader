FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js .
COPY lib/ ./lib/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]
