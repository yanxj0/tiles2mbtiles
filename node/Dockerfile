# 使用官方 Node.js LTS 镜像
FROM node:20-alpine

# 安装 curl 等基础工具（某些瓦片源可能需要）
RUN apk add --no-cache curl

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm ci

# 复制源码
COPY . .

# 启动命令
CMD ["npm", "start"]