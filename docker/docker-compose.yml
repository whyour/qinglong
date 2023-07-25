version: '2'
services:
  web:
    # alpine 基础镜像版本
    image: whyour/qinglong:latest
    # debian-slim 基础镜像版本
    # image: whyour/qinglong:debian  
    volumes:
      - ./data:/ql/data
    ports:
      - "0.0.0.0:5700:5700"
    environment:
      # 部署路径非必须，以斜杠开头和结尾，比如 /test/
      QlBaseUrl: '/'
    restart: unless-stopped
