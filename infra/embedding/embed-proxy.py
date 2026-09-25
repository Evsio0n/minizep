#!/usr/bin/env python3
"""
TCP proxy that exposes a compute node's embedding service on a gateway host,
so clients connect directly instead of tunnelling through a workstation.

    client ──► <gateway-host>:PORT ──► <compute-node>:PORT

The target is read from TARGET_FILE (written by supervise.sh), so when the job
moves to another node the proxy follows it without a restart. When there is no
target or it cannot be reached, the client gets an HTTP 503 with a JSON error in
llama-server's format instead of a silently closed connection.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

LISTEN_HOST = os.environ.get("PROXY_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PROXY_LISTEN_PORT", "11435"))
TARGET_FILE = Path(os.environ.get("PROXY_TARGET_FILE", "/mnt/ai-data/jobs/minizep-embed/current-target"))
CACHE_TTL = float(os.environ.get("PROXY_TARGET_TTL", "5"))
# How long a rejected client may take to send its request (and get it read) before
# the 503 goes out, and to finish sending afterwards.
REJECT_TIMEOUT = float(os.environ.get("PROXY_REJECT_TIMEOUT", "2"))

_target_cache: tuple[float, tuple[str, int] | None] = (0.0, None)


def read_target() -> tuple[str, int] | None:
    """host:port of the current backend, cached briefly to avoid a stat per packet."""
    global _target_cache
    now = time.monotonic()
    ts, cached = _target_cache
    if now - ts < CACHE_TTL:
        return cached
    try:
        raw = TARGET_FILE.read_text().strip()
        host, _, port = raw.partition(":")
        resolved = (host, int(port or LISTEN_PORT)) if host else None
    except (OSError, ValueError):
        resolved = None
    _target_cache = (now, resolved)
    return resolved


async def pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def unavailable_response(reason: str) -> bytes:
    """HTTP 503 with an error body shaped like llama-server's own (OpenAI style)."""
    body = json.dumps({
        "error": {
            "code": 503,
            "type": "unavailable_error",
            "message": f"embedding backend unavailable: {reason}",
        }
    }).encode()
    head = (
        "HTTP/1.1 503 Service Unavailable\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Retry-After: 5\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode()
    return head + body


async def discard(reader: asyncio.StreamReader) -> None:
    while await reader.read(65536):
        pass


async def reject(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, reason: str) -> None:
    """Answers 503. The request head is read first and the rest drained afterwards:
    closing a socket with unread input resets it, and the client would see a reset
    instead of the response."""
    try:
        await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=REJECT_TIMEOUT)
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        pass
    try:
        writer.write(unavailable_response(reason))
        await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
        await asyncio.wait_for(discard(reader), timeout=REJECT_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        pass
    finally:
        writer.close()


async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    target = read_target()
    if target is None:
        await reject(client_reader, client_writer, "no backend is configured")
        return
    try:
        up_reader, up_writer = await asyncio.wait_for(
            asyncio.open_connection(*target), timeout=10
        )
    except (OSError, asyncio.TimeoutError) as exc:
        print(f"[proxy] backend {target[0]}:{target[1]} unreachable: {exc}", file=sys.stderr, flush=True)
        # The backend address stays in the log; clients only learn that it is down.
        await reject(client_reader, client_writer, "backend not reachable")
        return
    await asyncio.gather(
        pump(client_reader, up_writer),
        pump(up_reader, client_writer),
        return_exceptions=True,
    )


async def main() -> None:
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    print(f"[proxy] listening on {LISTEN_HOST}:{LISTEN_PORT} -> {read_target()}", file=sys.stderr, flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
