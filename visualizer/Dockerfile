FROM node:22-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public

ENV PORT=8080
ENV CATALOGUE_DATA_DIR=/data
EXPOSE 8080

USER node
CMD ["node", "server.mjs"]
