# Two stages: the build stage needs the full dependency tree (esbuild ships with
# Vite), the runtime stage needs nothing but Node and one bundled file.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY server ./server
RUN npm run build:server

FROM node:22-alpine
WORKDIR /app
# `ws` is bundled in, so there is no node_modules at runtime at all.
COPY --from=build /app/server-dist/index.cjs ./index.cjs
ENV WS_PORT=8787
EXPOSE 8787
CMD ["node", "index.cjs"]
