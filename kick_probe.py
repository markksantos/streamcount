#!/usr/bin/env python3
"""Fetch Kick live viewer count via curl_cffi (Chrome TLS impersonation beats Cloudflare)."""
import json
import sys

from curl_cffi import requests

slug = sys.argv[1]
r = requests.get(f"https://kick.com/api/v2/channels/{slug}", impersonate="chrome", timeout=12)
r.raise_for_status()
ls = r.json().get("livestream")
if ls and ls.get("is_live"):
    print(json.dumps({"live": True, "viewers": ls.get("viewer_count", 0)}))
else:
    print(json.dumps({"live": False, "viewers": 0}))
