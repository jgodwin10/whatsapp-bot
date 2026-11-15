FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev
COPY . .
CMD ["npm", "start"]
