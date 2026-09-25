#!/usr/bin/env python3
"""
Tests for embed-proxy.py. The proxy runs as a subprocess on loopback in front of a
throwaway HTTP backend; nothing leaves the machine.

    python3 infra/embedding/test/test_embed_proxy.py
"""
import http.client
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

PROXY = Path(__file__).resolve().parent.parent / "embed-proxy.py"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class EchoBackend(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        reply = json.dumps({"echo": body.decode()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args) -> None:
        pass


class EmbedProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.target_file = Path(cls.tmp.name) / "current-target"
        cls.port = free_port()
        env = dict(
            os.environ,
            PROXY_LISTEN_HOST="127.0.0.1",
            PROXY_LISTEN_PORT=str(cls.port),
            PROXY_TARGET_FILE=str(cls.target_file),
            PROXY_TARGET_TTL="0",
        )
        cls.proxy = subprocess.Popen([sys.executable, str(PROXY)], env=env, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while True:
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=1).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.proxy.terminate()
        cls.proxy.wait(timeout=10)
        cls.tmp.cleanup()

    def post(self, body: bytes) -> tuple[int, dict, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("POST", "/v1/embeddings", body=body, headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    def assert_unavailable(self, status: int, headers: dict, body: bytes) -> None:
        self.assertEqual(status, 503)
        self.assertEqual(headers.get("Content-Type"), "application/json")
        error = json.loads(body)["error"]
        self.assertEqual(error["code"], 503)
        self.assertEqual(error["type"], "unavailable_error")
        self.assertIn("embedding backend unavailable", error["message"])

    def test_no_target_gives_503(self) -> None:
        self.target_file.unlink(missing_ok=True)
        self.assert_unavailable(*self.post(b'{"input":"hi"}'))

    def test_unreachable_backend_gives_503(self) -> None:
        self.target_file.write_text(f"127.0.0.1:{free_port()}\n")
        # A large body must not turn the answer into a connection reset.
        status, headers, body = self.post(json.dumps({"input": "x" * 4_000_000}).encode())
        self.assert_unavailable(status, headers, body)
        self.assertNotIn("127.0.0.1", body.decode(), "backend address leaked to the client")

    def test_healthy_backend_is_proxied(self) -> None:
        backend = http.server.ThreadingHTTPServer(("127.0.0.1", 0), EchoBackend)
        threading.Thread(target=backend.serve_forever, daemon=True).start()
        try:
            self.target_file.write_text(f"127.0.0.1:{backend.server_address[1]}\n")
            status, _, body = self.post(b'{"input":"hi"}')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"echo": '{"input":"hi"}'})
        finally:
            backend.shutdown()
            backend.server_close()


if __name__ == "__main__":
    unittest.main()
