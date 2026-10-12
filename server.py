"""Dependency-free web server for the Terraform architecture explorer."""

from __future__ import annotations

import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from analyzer import analyze_files
from gemini import GeminiError, explain_architecture, load_dotenv, status as gemini_status


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
MAX_REQUEST_BYTES = 6 * 1024 * 1024


class ExplorerHandler(BaseHTTPRequestHandler):
    server_version = "TerraformExplorer/1.0"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json_response(200, {"status": "ok"})
            return
        if path == "/api/ai/status":
            try:
                self._json_response(200, gemini_status())
            except GeminiError as error:
                self._json_response(500, {"error": str(error)})
            return
        public_files = {
            "/": "index.html",
            "/index.html": "index.html",
            "/styles.css": "styles.css",
            "/app.js": "app.js",
        }
        filename = public_files.get(path)
        if filename is None:
            self._json_response(404, {"error": "Not found."})
            return
        file_path = WEB_ROOT / filename
        try:
            content = file_path.read_bytes()
        except OSError as error:
            self._json_response(500, {"error": f"Could not read application asset: {error}"})
            return
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path not in {"/api/analyze", "/api/ai/explain"}:
            self._json_response(404, {"error": "Not found."})
            return
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._json_response(411, {"error": "Content-Length is required."})
            return
        try:
            length = int(content_length)
        except ValueError:
            self._json_response(400, {"error": "Invalid Content-Length."})
            return
        if length < 0 or length > MAX_REQUEST_BYTES:
            self._json_response(413, {"error": "Request exceeds the 6 MB upload limit."})
            return
        if self.headers.get_content_type() != "application/json":
            self._json_response(415, {"error": "Send JSON with an object of Terraform file paths to text contents."})
            return
        try:
            payload: Any = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or not isinstance(payload.get("files"), dict):
                raise ValueError("Request must contain a 'files' object.")
            files = payload["files"]
            if not all(isinstance(name, str) and isinstance(text, str) for name, text in files.items()):
                raise ValueError("Each file path and file content must be text.")
            for name in files:
                normalized = name.replace("\\", "/").lower()
                if normalized.endswith((".tfstate", ".tfstate.backup")) or "terraform.tfstate" in normalized:
                    continue
                if not normalized.endswith((".tf", ".tf.json")):
                    raise ValueError(f"Unsupported file '{name}'; only .tf and .tf.json are accepted.")
            result = analyze_files(files)
            if path == "/api/ai/explain":
                self._json_response(200, explain_architecture(result))
                return
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json_response(400, {"error": "Request body is not valid UTF-8 JSON."})
            return
        except ValueError as error:
            self._json_response(400, {"error": str(error)})
            return
        except GeminiError as error:
            self._json_response(502, {"error": str(error)})
            return
        self._json_response(200, result)

    def _json_response(self, status: int, payload: dict[str, Any]) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")


def main() -> None:
    try:
        load_dotenv(ROOT / ".env")
    except GeminiError as error:
        raise SystemExit(str(error)) from error
    host = "127.0.0.1"
    port = 8000
    print(f"Terraform Architecture Explorer is running at http://{host}:{port}")
    with ThreadingHTTPServer((host, port), ExplorerHandler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()
