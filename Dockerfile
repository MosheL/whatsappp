FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package-lock.json package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi && \
  sed -i 's|ev.emit("presence.update", { id: jid, presences|ev.emit("presence.update", { id: jid, to: attrs.to, presences|' /app/node_modules/@whiskeysockets/baileys/lib/Socket/chats.js

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
