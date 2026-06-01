import json
import os
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="HTTP Debugger")

DATA_DIR = "data"
COLLECTIONS_FILE = os.path.join(DATA_DIR, "collections.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs("static", exist_ok=True)


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


class ProxyRequest(BaseModel):
    method: str
    url: str
    headers: Dict[str, Any] = {}
    params: Dict[str, Any] = {}
    body_mode: str = "none"
    body_raw: str = ""
    body_form: List[Dict] = []
    body_urlencoded: List[Dict] = []
    auth_type: str = "none"
    auth_bearer: str = ""
    auth_username: str = ""
    auth_password: str = ""
    verify_ssl: bool = False
    use_sys_proxy: bool = False


class Collection(BaseModel):
    id: Optional[str] = None
    name: str
    items: List[Any] = []


@app.post("/api/proxy")
async def proxy_request(req: ProxyRequest):
    headers = {k: str(v) for k, v in req.headers.items() if v is not None}

    auth = None
    if req.auth_type == "bearer":
        headers["Authorization"] = f"Bearer {req.auth_bearer}"
    elif req.auth_type == "basic":
        auth = (req.auth_username, req.auth_password)

    params = {k: str(v) for k, v in req.params.items() if v is not None} if req.params else {}

    content = None
    data = None

    if req.body_mode == "raw" and req.body_raw:
        content = req.body_raw.encode("utf-8")
        if not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = "application/json"
    elif req.body_mode == "urlencoded":
        data = {i["key"]: i["value"] for i in req.body_urlencoded if i.get("enabled", True) and i.get("key")}
    elif req.body_mode == "form-data":
        data = {i["key"]: i["value"] for i in req.body_form if i.get("enabled", True) and i.get("key")}

    start = time.time()
    try:
        async with httpx.AsyncClient(
            verify=req.verify_ssl,
            follow_redirects=True,
            timeout=30.0,
            trust_env=req.use_sys_proxy,  # 默认绕过系统代理，本地接口不走代理
        ) as client:
            response = await client.request(
                method=req.method.upper(),
                url=req.url,
                headers=headers,
                params=params,
                content=content,
                data=data,
                auth=auth,
            )

        elapsed = round((time.time() - start) * 1000)

        try:
            body = response.text
        except Exception:
            body = response.content.decode("utf-8", errors="replace")

        result = {
            "status": response.status_code,
            "status_text": response.reason_phrase,
            "headers": dict(response.headers),
            "body": body,
            "elapsed": elapsed,
            "size": len(response.content),
        }

        _save_history({
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "method": req.method.upper(),
            "url": req.url,
            "status": response.status_code,
            "elapsed": elapsed,
            "request": req.dict(),
            "response": result,
        })

        return result

    except httpx.SSLError as e:
        raise HTTPException(400, f"SSL Error: {e}. 请尝试关闭 SSL 验证。")
    except httpx.ConnectError as e:
        raise HTTPException(400, f"连接失败: {e}")
    except httpx.TimeoutException:
        raise HTTPException(408, "请求超时")
    except Exception as e:
        raise HTTPException(500, str(e))


def _save_history(entry):
    history = load_json(HISTORY_FILE, [])
    history.insert(0, entry)
    save_json(HISTORY_FILE, history[:100])


@app.get("/api/history")
def get_history():
    return load_json(HISTORY_FILE, [])


@app.delete("/api/history")
def clear_history():
    save_json(HISTORY_FILE, [])
    return {"ok": True}


@app.get("/api/collections")
def get_collections():
    return load_json(COLLECTIONS_FILE, [])


@app.post("/api/collections")
def create_collection(col: Collection):
    cols = load_json(COLLECTIONS_FILE, [])
    col.id = str(uuid.uuid4())
    cols.append(col.dict())
    save_json(COLLECTIONS_FILE, cols)
    return col


@app.put("/api/collections/{col_id}")
def update_collection(col_id: str, col: Collection):
    cols = load_json(COLLECTIONS_FILE, [])
    for i, c in enumerate(cols):
        if c["id"] == col_id:
            col.id = col_id
            cols[i] = col.dict()
            save_json(COLLECTIONS_FILE, cols)
            return col
    raise HTTPException(404, "Collection not found")


@app.delete("/api/collections/{col_id}")
def delete_collection(col_id: str):
    cols = load_json(COLLECTIONS_FILE, [])
    save_json(COLLECTIONS_FILE, [c for c in cols if c["id"] != col_id])
    return {"ok": True}


@app.post("/api/import")
async def import_collection(request: Request):
    body = await request.json()
    if "info" in body and "item" in body:
        col = _from_postman(body)
    else:
        col = body
    if not col.get("id"):
        col["id"] = str(uuid.uuid4())
    cols = load_json(COLLECTIONS_FILE, [])
    for i, c in enumerate(cols):
        if c.get("id") == col["id"]:
            cols[i] = col
            save_json(COLLECTIONS_FILE, cols)
            return col
    cols.append(col)
    save_json(COLLECTIONS_FILE, cols)
    return col


@app.get("/api/export/{col_id}")
def export_collection(col_id: str):
    cols = load_json(COLLECTIONS_FILE, [])
    col = next((c for c in cols if c["id"] == col_id), None)
    if not col:
        raise HTTPException(404, "Collection not found")
    exported = _to_postman(col)
    return JSONResponse(
        content=exported,
        headers={"Content-Disposition": f'attachment; filename="{col["name"]}.json"'},
    )


def _from_postman(pm: dict) -> dict:
    def conv(item):
        if "item" in item:
            return {"id": str(uuid.uuid4()), "type": "folder", "name": item.get("name", "Folder"),
                    "items": [conv(i) for i in item["item"]]}
        req = item.get("request", {})
        url_obj = req.get("url", {})
        if isinstance(url_obj, str):
            raw_url, params = url_obj, []
        else:
            raw_url = url_obj.get("raw", "")
            params = [{"key": q.get("key", ""), "value": q.get("value", ""), "enabled": not q.get("disabled", False)}
                      for q in url_obj.get("query", [])]
        headers = [{"key": h.get("key", ""), "value": h.get("value", ""), "enabled": not h.get("disabled", False)}
                   for h in req.get("header", [])]
        bd = req.get("body") or {}
        body = {"mode": bd.get("mode", "none"), "raw": bd.get("raw", ""), "rawType": "json",
                "formData": [{"key": f.get("key", ""), "value": f.get("value", ""), "enabled": not f.get("disabled", False)}
                              for f in bd.get("formdata", [])],
                "urlencoded": [{"key": f.get("key", ""), "value": f.get("value", ""), "enabled": not f.get("disabled", False)}
                               for f in bd.get("urlencoded", [])]}
        auth_obj = req.get("auth") or {}
        auth_type = auth_obj.get("type", "none")
        auth = {"type": auth_type}
        if auth_type == "bearer":
            bl = auth_obj.get("bearer", [])
            auth["bearer"] = next((b["value"] for b in bl if isinstance(bl, list) and b.get("key") == "token"), "")
        elif auth_type == "basic":
            bl = auth_obj.get("basic", [])
            if isinstance(bl, list):
                auth["username"] = next((b["value"] for b in bl if b.get("key") == "username"), "")
                auth["password"] = next((b["value"] for b in bl if b.get("key") == "password"), "")
        return {"id": str(uuid.uuid4()), "type": "request", "name": item.get("name", "Request"),
                "method": req.get("method", "GET"), "url": raw_url,
                "headers": headers, "params": params, "body": body, "auth": auth}

    return {"id": str(uuid.uuid4()), "name": pm.get("info", {}).get("name", "Imported"),
            "items": [conv(i) for i in pm.get("item", [])]}


def _to_postman(col: dict) -> dict:
    def conv(item):
        if item.get("type") == "folder":
            return {"name": item["name"], "item": [conv(i) for i in item.get("items", [])]}
        url = item.get("url", "")
        params = item.get("params", [])
        url_obj = {"raw": url, "query": [{"key": p["key"], "value": p["value"],
                                           "disabled": not p.get("enabled", True)}
                                          for p in params if p.get("key")]}
        headers = [{"key": h["key"], "value": h["value"], "disabled": not h.get("enabled", True)}
                   for h in item.get("headers", []) if h.get("key")]
        bd = item.get("body") or {}
        mode = bd.get("mode", "none")
        body = {"mode": mode}
        if mode == "raw":
            body["raw"] = bd.get("raw", "")
            body["options"] = {"raw": {"language": "json"}}
        elif mode == "form-data":
            body["formdata"] = [{"key": f["key"], "value": f["value"]} for f in bd.get("formData", []) if f.get("key")]
        elif mode == "urlencoded":
            body["urlencoded"] = [{"key": f["key"], "value": f["value"]} for f in bd.get("urlencoded", []) if f.get("key")]
        auth_d = item.get("auth") or {}
        auth_type = auth_d.get("type", "noauth")
        if auth_type == "none":
            auth_type = "noauth"
        auth = {"type": auth_type}
        if auth_type == "bearer":
            auth["bearer"] = [{"key": "token", "value": auth_d.get("bearer", ""), "type": "string"}]
        elif auth_type == "basic":
            auth["basic"] = [{"key": "username", "value": auth_d.get("username", ""), "type": "string"},
                              {"key": "password", "value": auth_d.get("password", ""), "type": "string"}]
        return {"name": item.get("name", "Request"),
                "request": {"method": item.get("method", "GET"), "header": headers,
                             "url": url_obj, "body": body, "auth": auth},
                "response": []}

    return {"info": {"name": col["name"], "_postman_id": col.get("id", str(uuid.uuid4())),
                     "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
            "item": [conv(i) for i in col.get("items", [])]}


app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8899, reload=True)
