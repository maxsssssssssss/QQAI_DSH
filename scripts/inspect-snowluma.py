#!/usr/bin/env python3
"""Inspect SnowLuma 2.2.1 through loopback without printing private API fields.

Run as root on the project server. One temporary WebUI login is created from
the protected bootstrap password and logged out in finally. This does not
accept agreements, change passwords, load a QQ process, or send messages.
No server error text, account identifiers, token, cookie or response is emitted.
"""
import json
import os
from pathlib import Path
import stat
import urllib.error
import urllib.request

ORIGIN = "http://127.0.0.1:5099"
PASSWORD_FILE = Path("/etc/qqai-dsh/snowluma.env")
PROCESS_STATES = {"available", "loading", "connecting", "loaded", "online", "error", "disconnected"}
ADAPTER_KINDS = {"httpServer", "httpClient", "wsServer", "wsClient"}
ADAPTER_STATES = {"ok", "warn", "down", "disabled", "degraded"}


class InspectionError(Exception):
    def __init__(self, code, status=None):
        self.code, self.status = code, status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InspectionError("unexpected_redirect")


def request(opener, route, token=None, body=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["x-snowluma-token"] = token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(ORIGIN + route, data=data, headers=headers)
    try:
        with opener.open(req, timeout=15) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise InspectionError("oversized_response")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise InspectionError("unexpected_response")
            return result
    except urllib.error.HTTPError as error:
        raise InspectionError("http_error", error.code) from None
    except (urllib.error.URLError, OSError):
        raise InspectionError("connection_error") from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise InspectionError("invalid_json") from None


def read_password():
    # Refuse symlink or readable-by-other-user credential files.
    fd = os.open(PASSWORD_FILE, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
            raise InspectionError("unsafe_credential_file")
        raw = os.read(fd, 64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            raise InspectionError("oversized_credential_file")
    finally:
        os.close(fd)
    values = [line.split("=", 1)[1].strip() for line in raw.decode("utf-8").splitlines()
              if line.startswith("SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=")]
    if len(values) != 1 or not values[0]:
        raise InspectionError("missing_bootstrap_password")
    value = values[0]
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def enum(value, allowed):
    return value if isinstance(value, str) and value in allowed else "unknown"


def inspect():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    token = None
    output = {"consentAccepted": None, "mustChangePassword": None,
              "processes": None, "qqConnectedAccountCount": None, "connections": None}
    try:
        login = request(opener, "/api/login", body={"password": read_password()})
        if login.get("needsTotp") is True:
            raise InspectionError("user_second_factor_required")
        token = login.get("token")
        if login.get("success") is not True or not isinstance(token, str) or not token:
            raise InspectionError("login_not_completed")
        output["mustChangePassword"] = login.get("mustChangePassword") is True
        agreements = request(opener, "/api/agreements", token)
        docs = agreements.get("documents", [])
        complete = isinstance(docs, list) and all(any(isinstance(d, dict) and d.get("id") == key
            and isinstance(d.get("text"), str) and d["text"].strip() for d in docs)
            for key in ("eula", "privacy"))
        output["consentAccepted"] = complete and agreements.get("consentRequired") is False
        if not output["consentAccepted"] or output["mustChangePassword"]:
            return output
        processes = request(opener, "/api/processes", token).get("list")
        qq = request(opener, "/api/qq-list", token).get("list")
        connections = request(opener, "/api/connections", token).get("list")
        if not all(isinstance(value, list) for value in (processes, qq, connections)):
            raise InspectionError("unexpected_list_schema")
        output["processes"] = [{
            "pid": p.get("pid") if type(p.get("pid")) is int else None,
            "injected": p.get("injected") is True,
            "connected": p.get("connected") is True,
            "loggedIn": p.get("loggedIn") is True,
            "hasAccount": isinstance(p.get("account"), dict) and bool(p["account"].get("uin")),
            "status": enum(p.get("status"), PROCESS_STATES),
        } for p in processes if isinstance(p, dict)]
        output["qqConnectedAccountCount"] = len(qq)
        output["connections"] = [{
            "adapters": [{"kind": enum(a.get("kind"), ADAPTER_KINDS),
                          "status": enum(a.get("status"), ADAPTER_STATES),
                          "hasError": bool(a.get("lastError"))}
                         for a in c.get("adapters", []) if isinstance(a, dict)]
        } for c in connections if isinstance(c, dict)]
        return output
    finally:
        if token:
            try:
                request(opener, "/api/logout", token, {})
            except InspectionError:
                pass


if __name__ == "__main__":
    try:
        print(json.dumps(inspect(), ensure_ascii=False))
    except InspectionError as error:
        print(json.dumps({"inspectionError": error.code, "httpStatus": error.status}))
        raise SystemExit(1)
    except Exception:
        # No traceback: credential content or server response must never leak.
        print(json.dumps({"inspectionError": "local_inspection_failed"}))
        raise SystemExit(1)
