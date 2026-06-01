import json
import os
import secrets
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import hashlib
import hmac

import httpx
import jwt
from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="HTTP Debugger")

DATA_DIR = "data"
USERS_FILE = os.path.join(DATA_DIR, "users.json")
ALGORITHM = "HS256"
TOKEN_DAYS = 30

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs("static", exist_ok=True)

bearer_scheme = HTTPBearer(auto_error=False)
_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS)
    return f"pbkdf2:{salt}:{key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, key_hex = stored.split(":")
        key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS)
        return hmac.compare_digest(key.hex(), key_hex)
    except Exception:
        return False


def _get_secret() -> str:
    path = os.path.join(DATA_DIR, ".secret")
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as f:
        f.write(key)
    return key


SECRET_KEY = _get_secret()


# ── File helpers ──────────────────────────────────────────────────────────

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def col_path(user_id: str) -> str:
    return os.path.join(DATA_DIR, f"collections_{user_id}.json")


def hist_path(user_id: str) -> str:
    return os.path.join(DATA_DIR, f"history_{user_id}.json")


# ── Auth ──────────────────────────────────────────────────────────────────

def make_token(user_id: str) -> str:
    exp = datetime.utcnow() + timedelta(days=TOKEN_DAYS)
    return jwt.encode({"sub": user_id, "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
) -> dict:
    if not credentials:
        raise HTTPException(401, "未登录，请先登录")
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub", "")
        if not user_id:
            raise HTTPException(401, "Token 无效")
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "登录已过期，请重新登录")
    except jwt.PyJWTError:
        raise HTTPException(401, "Token 无效")
    user = next((u for u in load_json(USERS_FILE, []) if u["id"] == user_id), None)
    if not user:
        raise HTTPException(401, "用户不存在")
    return user


class AuthReq(BaseModel):
    username: str
    password: str


@app.post("/api/auth/register")
def register(req: AuthReq):
    name = req.username.strip()
    if len(name) < 2:
        raise HTTPException(400, "用户名至少 2 个字符")
    if len(req.password) < 6:
        raise HTTPException(400, "密码至少 6 个字符")
    users = load_json(USERS_FILE, [])
    if any(u["username"].lower() == name.lower() for u in users):
        raise HTTPException(400, "用户名已存在")
    user = {
        "id": str(uuid.uuid4()),
        "username": name,
        "password_hash": hash_password(req.password),
        "created_at": datetime.now().isoformat(),
    }
    users.append(user)
    save_json(USERS_FILE, users)
    return {"token": make_token(user["id"]), "user": {"id": user["id"], "username": user["username"]}}


@app.post("/api/auth/login")
def login(req: AuthReq):
    users = load_json(USERS_FILE, [])
    user = next((u for u in users if u["username"].lower() == req.username.strip().lower()), None)
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(401, "用户名或密码错误")
    return {"token": make_token(user["id"]), "user": {"id": user["id"], "username": user["username"]}}


@app.get("/api/auth/me")
def get_me(current_user: dict = Depends(get_current_user)):
    return {"id": current_user["id"], "username": current_user["username"]}


# ── Models ────────────────────────────────────────────────────────────────

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


# ── Proxy ──────────────────────────────────────────────────────────────────

@app.post("/api/proxy")
async def proxy_request(req: ProxyRequest, current_user: dict = Depends(get_current_user)):
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
            trust_env=req.use_sys_proxy,
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
        }, current_user["id"])

        return result

    except httpx.SSLError as e:
        raise HTTPException(400, f"SSL Error: {e}. 请尝试关闭 SSL 验证。")
    except httpx.ConnectError as e:
        raise HTTPException(400, f"连接失败: {e}")
    except httpx.TimeoutException:
        raise HTTPException(408, "请求超时")
    except Exception as e:
        raise HTTPException(500, str(e))


def _save_history(entry, user_id: str):
    path = hist_path(user_id)
    history = load_json(path, [])
    history.insert(0, entry)
    save_json(path, history[:100])


# ── History ───────────────────────────────────────────────────────────────

@app.get("/api/history")
def get_history(current_user: dict = Depends(get_current_user)):
    return load_json(hist_path(current_user["id"]), [])


@app.delete("/api/history")
def clear_history(current_user: dict = Depends(get_current_user)):
    save_json(hist_path(current_user["id"]), [])
    return {"ok": True}


# ── Collections ───────────────────────────────────────────────────────────

@app.get("/api/collections")
def get_collections(current_user: dict = Depends(get_current_user)):
    return load_json(col_path(current_user["id"]), [])


@app.post("/api/collections")
def create_collection(col: Collection, current_user: dict = Depends(get_current_user)):
    path = col_path(current_user["id"])
    cols = load_json(path, [])
    col.id = str(uuid.uuid4())
    cols.append(col.dict())
    save_json(path, cols)
    return col


@app.put("/api/collections/{col_id}")
def update_collection(col_id: str, col: Collection, current_user: dict = Depends(get_current_user)):
    path = col_path(current_user["id"])
    cols = load_json(path, [])
    for i, c in enumerate(cols):
        if c["id"] == col_id:
            col.id = col_id
            cols[i] = col.dict()
            save_json(path, cols)
            return col
    raise HTTPException(404, "Collection not found")


@app.delete("/api/collections/{col_id}")
def delete_collection(col_id: str, current_user: dict = Depends(get_current_user)):
    path = col_path(current_user["id"])
    cols = load_json(path, [])
    save_json(path, [c for c in cols if c["id"] != col_id])
    return {"ok": True}


# ── Import / Export ───────────────────────────────────────────────────────

@app.post("/api/import")
async def import_collection(request: Request, current_user: dict = Depends(get_current_user)):
    path = col_path(current_user["id"])
    body = await request.json()
    col = _from_postman(body) if ("info" in body and "item" in body) else body
    if not col.get("id"):
        col["id"] = str(uuid.uuid4())
    cols = load_json(path, [])
    for i, c in enumerate(cols):
        if c.get("id") == col["id"]:
            cols[i] = col
            save_json(path, cols)
            return col
    cols.append(col)
    save_json(path, cols)
    return col


@app.get("/api/export/{col_id}")
def export_collection(col_id: str, current_user: dict = Depends(get_current_user)):
    cols = load_json(col_path(current_user["id"]), [])
    col = next((c for c in cols if c["id"] == col_id), None)
    if not col:
        raise HTTPException(404, "Collection not found")
    return JSONResponse(
        content=_to_postman(col),
        headers={"Content-Disposition": f'attachment; filename="{col["name"]}.json"'},
    )


# ── Postman format conversion ─────────────────────────────────────────────

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
