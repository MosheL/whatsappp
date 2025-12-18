FROM node:24-alpine

WORKDIR /app

COPY . .

RUN npm install
RUN echo 1234 > /app/temp.txt
CMD ["node", "--experimental-strip-types", "./src/index.ts"]
