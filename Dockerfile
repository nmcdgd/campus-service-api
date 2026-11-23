FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund

COPY . .

EXPOSE 80

CMD ["node", "index.js"]