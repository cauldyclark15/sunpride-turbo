#!/usr/bin/env python3
"""Host receiver for emulator screenshots sent by `captureCalmScreenshot` (androidTest CalmScreenshotSink.kt).

The emulator reaches the host at 10.0.2.2:28765. Each message is "<name>\\n<byteCount>\\n<png bytes>";
the receiver writes <out>/<name>.png and acknowledges with one byte. Stop with Ctrl-C.

    python3 apps/field-android/scripts/receive-screenshots.py docs/guides/field-sales/images [--prefix guide-]

With --prefix, only matching names are saved and the prefix is stripped from the file name.
"""
import argparse
import os
import re
import socket


def read_line(conn):
    data = b""
    while not data.endswith(b"\n"):
        chunk = conn.recv(1)
        if not chunk:
            raise ConnectionError("closed before header")
        data += chunk
    return data[:-1].decode("utf-8")


def read_exact(conn, size):
    buf = bytearray()
    while len(buf) < size:
        chunk = conn.recv(min(65536, size - len(buf)))
        if not chunk:
            raise ConnectionError("closed before image end")
        buf.extend(chunk)
    return bytes(buf)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--prefix", default="")
    parser.add_argument("--port", type=int, default=28765)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", args.port))
    server.listen(4)
    print(f"listening on 127.0.0.1:{args.port} -> {args.out}", flush=True)
    while True:
        conn, _ = server.accept()
        with conn:
            name = read_line(conn)
            size = int(read_line(conn))
            png = read_exact(conn, size)
            if not re.fullmatch(r"[A-Za-z0-9._-]+", name) or not png.startswith(b"\x89PNG"):
                conn.sendall(b"\x00")
                continue
            if name.startswith(args.prefix):
                path = os.path.join(args.out, name[len(args.prefix):] + ".png")
                with open(path, "wb") as f:
                    f.write(png)
                print(f"saved {path} ({size} bytes)", flush=True)
            conn.sendall(b"\x01")


if __name__ == "__main__":
    main()
