# HTTP Debugger

本地 HTTP 接口调试工具，类似 Postman 的 Collection 功能，支持 HTTPS（含自签名证书）。

## 快速开始

**安装依赖**
```bash
pip install -r requirements.txt
```

**启动服务**
```bash
./start.sh
```

浏览器访问 [http://localhost:8899](http://localhost:8899)

> `start.sh` 会自动关闭旧进程再重启，服务支持热重载。

## 功能

| 功能 | 说明 |
|---|---|
| HTTP 方法 | GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS |
| Query Params | 与 URL 输入框双向同步 |
| Headers | 键值对编辑，支持单行启用/禁用 |
| Body | raw（JSON / Text / HTML / XML）、form-data、x-www-form-urlencoded |
| Auth | Bearer Token、Basic Auth |
| SSL 验证 | 默认关闭，可勾选开启，支持调试自签名证书 |
| Collections | 创建/重命名/删除，支持文件夹嵌套，保存和更新请求 |
| 历史记录 | 保留最近 100 条，点击可重新加载请求与响应 |
| 导入 | 支持 Postman Collection v2.1 格式 `.json` |
| 导出 | 导出为 Postman Collection v2.1 格式，可直接导入 Postman |
| JSON 高亮 | 响应体自动格式化并语法高亮 |

## 快捷键

| 快捷键 | 操作 |
|---|---|
| `Ctrl + Enter` | 发送请求 |
| `Esc` | 关闭弹窗 |

## 技术栈

- **后端**：Python · FastAPI · httpx
- **前端**：原生 HTML / CSS / JS，无构建步骤
- **数据存储**：本地 JSON 文件（`data/` 目录）

## 目录结构

```
poster/
├── main.py              # FastAPI 后端
├── requirements.txt
├── start.sh             # 启动脚本
├── data/                # 运行时自动生成
│   ├── collections.json # 保存的请求集合
│   └── history.json     # 请求历史（最多 100 条）
└── static/
    ├── index.html
    ├── style.css
    └── app.js
```
