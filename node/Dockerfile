# 使用官方 Node.js LTS 镜像
FROM node:20-alpine

# 安装 curl 和解压工具
RUN apk add --no-cache curl tar

# 下载并安装 pmtiles CLI (Linux x86_64 版本)
# 注意：如果是 ARM 架构（如 Mac M1/M2），请将 URL 中的 'x86_64' 改为 'arm64'
RUN curl -L https://github.com/protomaps/go-pmtiles/releases/download/v1.23.1/go-pmtiles_1.23.1_Linux_x86_64.tar.gz | tar -xz -C /usr/local/bin pmtiles \
    && chmod +x /usr/local/bin/pmtiles

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制源码
COPY . .

# 启动命令增加 --expose-gc 参数 
CMD ["node", "--max-old-space-size=8192", "--expose-gc", "index.js", "download"]