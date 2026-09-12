#!/usr/bin/env python3
"""Run Google's installed-app OAuth flow and print a YouTube refresh token."""

from __future__ import annotations

import os
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Set {name} before running this script")
    return value


def main() -> int:
    try:
        client_config = {
            "installed": {
                "client_id": required_env("YOUTUBE_CLIENT_ID"),
                "client_secret": required_env("YOUTUBE_CLIENT_SECRET"),
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        }
        flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
        credentials = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    except Exception as exc:
        print(f"OAuth flow failed: {exc}", file=sys.stderr)
        return 1

    if not credentials.refresh_token:
        print("Google did not return a refresh token. Revoke prior app access and retry.", file=sys.stderr)
        return 1
    print("\nYOUTUBE_REFRESH_TOKEN=" + credentials.refresh_token)
    return 0


if __name__ == "__main__":
    sys.exit(main())

