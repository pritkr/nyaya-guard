FROM node:20-alpine AS web
WORKDIR /app/web
COPY web/package.json ./
RUN npm install --no-audit --no-fund || true
COPY web/ ./
RUN npm run build || (mkdir -p dist && echo '<h1>web build skipped</h1>' > dist/index.html)

FROM node:20-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src/ ./src/
COPY data/ ./data/
COPY eval/ ./eval/
# v3: db/schema.sql + db/role.sql ship in the image so migrations can be applied
# from the running container (store.applySchema()) without a separate checkout.
COPY db/ ./db/
RUN npm run build || true
COPY --from=web /app/web/dist ./web-dist
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
