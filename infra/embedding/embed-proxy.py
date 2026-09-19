#!/usr/bin/env python3
"""
TCP proxy that exposes a compute node's embedding service on a gateway host,
so clients connect directly instead of tunnelling through a workstation.

    client ──► <gateway-host>:PORT ──► <compute-node>:PORT

The target is read from TARGET_FILE (written by supervise.sh), so when the job
moves to another node the proxy follows it without a restart.
"""
import asyncio
import os
import sys
import time
from pathlib import Path

LISTEN_HOST = os.environ.get("PROXY_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PROXY_LISTEN_PORT", "11435"))
TARGET_FILE = Path(os.environ.get("PROXY_TARGET_FILE", "/mnt/ai-data/jobs/minizep-embed/current-target"))
CACHE_TTL = float(os.environ.get("PROXY_TARGET_TTL", "5"))

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


async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    target = read_target()
    if target is None:
        client_writer.close()
        return
    try:
        up_reader, up_writer = await asyncio.wait_for(
            asyncio.open_connection(*target), timeout=10
        )
    except (OSError, asyncio.TimeoutError) as exc:
        print(f"[proxy] backend {target[0]}:{target[1]} unreachable: {exc}", file=sys.stderr, flush=True)
        client_writer.close()
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
