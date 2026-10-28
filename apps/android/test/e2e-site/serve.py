#!/usr/bin/env python3
"""Static server for the emulator smoke test: python3 serve.py [port]. Sends no-store so edits show up."""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
ThreadingHTTPServer(("0.0.0.0", port), partial(Handler, directory=sys.path[0])).serve_forever()
