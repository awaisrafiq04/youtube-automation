#!/usr/bin/env python3
"""Upload queued Supabase videos to YouTube Shorts."""

from __future__ import annotations

import argparse
import base64
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from supabase import Client, create_client

YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
DEFAULT_BUCKET = "shorts-videos"
CHUNK_SIZE = 8 * 1024 * 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
LOGGER = logging.getLogger("upload-shorts")


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Required environment variable {name} is not set")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--count",
        type=int,
        default=2,
        help="maximum number of queued videos to process (default: 2)",
    )
    parser.add_argument(
        "--repeat",
        action="store_true",
        help="cycle all rows by least-recent upload instead of selecting only posted=false",
    )
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be at least 1")
    return args


def create_supabase_client() -> Client:
    return create_client(
        required_env("SUPABASE_URL"),
        required_env("SUPABASE_SERVICE_ROLE_KEY"),
    )


def create_youtube_client(
    refresh_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> Any:
    credentials = Credentials(
        token=None,
        refresh_token=refresh_token or required_env("YOUTUBE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id or required_env("YOUTUBE_CLIENT_ID"),
        client_secret=client_secret or required_env("YOUTUBE_CLIENT_SECRET"),
        scopes=YOUTUBE_SCOPES,
    )
    return build("youtube", "v3", credentials=credentials, cache_discovery=False)


def decrypt_channel_token(ciphertext: str, iv: str) -> str:
    key = base64.b64decode(required_env("CHANNEL_TOKEN_ENCRYPTION_KEY"), validate=True)
    if len(key) != 32:
        raise ValueError("CHANNEL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes")
    plaintext = AESGCM(key).decrypt(base64.b64decode(iv), base64.b64decode(ciphertext), None)
    return plaintext.decode("utf-8")


def get_active_channel(supabase: Client) -> dict[str, Any] | None:
    try:
        query = supabase.table("youtube_channels").select(
            "id,user_id,youtube_channel_id,display_name"
        ).eq("active", True)
        owner_id = os.environ.get("DASHBOARD_USER_ID", "").strip()
        if owner_id:
            query = query.eq("user_id", owner_id)
        response = query.limit(2).execute()
    except Exception:
        LOGGER.warning("Dashboard channel tables unavailable; using legacy YouTube secret")
        return None
    channels = list(response.data or [])
    if not channels:
        return None
    if len(channels) > 1:
        raise RuntimeError("Multiple active channels found; set DASHBOARD_USER_ID")
    channel = channels[0]
    token_response = (
        supabase.table("youtube_channel_tokens")
        .select("token_ciphertext,token_iv")
        .eq("channel_id", channel["id"])
        .single()
        .execute()
    )
    token = token_response.data
    channel["refresh_token"] = decrypt_channel_token(
        token["token_ciphertext"], token["token_iv"]
    )
    return channel


def get_pending_videos(
    supabase: Client, count: int, repeat: bool = False, owner_id: str | None = None
) -> list[dict[str, Any]]:
    query = supabase.table("videos").select(
        "id,storage_path,title,description,tags,category_id,privacy_status,"
        "posted,posted_at,created_at,user_id,channel_id"
    )
    if owner_id:
        query = query.eq("user_id", owner_id)
    if repeat:
        # Never-posted rows come first; afterward rotate the least-recent upload.
        query = query.order("posted_at", nullsfirst=True).order("created_at").order("id")
    else:
        query = query.eq("posted", False).order("created_at").order("id")
    response = query.limit(count).execute()
    return list(response.data or [])


def shorts_title(raw_title: str | None) -> str:
    title = (raw_title or "Untitled Short").strip()
    if "#shorts" not in title.lower():
        suffix = " #Shorts"
        title = title[: 100 - len(suffix)].rstrip() + suffix
    return title[:100]


def shorts_tags(raw_tags: Any) -> list[str]:
    tags = [str(tag).strip() for tag in (raw_tags or []) if str(tag).strip()]
    if not any(tag.lower().lstrip("#") == "shorts" for tag in tags):
        tags.append("Shorts")
    return tags


def download_video(supabase: Client, bucket: str, storage_path: str) -> Path:
    payload = supabase.storage.from_(bucket).download(storage_path)
    if not isinstance(payload, (bytes, bytearray)):
        raise TypeError("Supabase Storage returned a non-bytes response")

    suffix = Path(storage_path).suffix or ".mp4"
    temp = tempfile.NamedTemporaryFile(prefix="youtube-short-", suffix=suffix, delete=False)
    try:
        temp.write(payload)
        return Path(temp.name)
    except Exception:
        temp.close()
        Path(temp.name).unlink(missing_ok=True)
        raise
    finally:
        temp.close()


def upload_video(youtube: Any, video: dict[str, Any], file_path: Path) -> str:
    body = {
        "snippet": {
            "title": shorts_title(video.get("title")),
            "description": video.get("description") or "",
            "tags": shorts_tags(video.get("tags")),
            "categoryId": str(video.get("category_id") or "22"),
        },
        "status": {
            "privacyStatus": video.get("privacy_status") or "public",
        },
    }
    media = MediaFileUpload(
        str(file_path),
        mimetype="video/mp4",
        chunksize=CHUNK_SIZE,
        resumable=True,
    )
    request = youtube.videos().insert(
        part="snippet,status",
        body=body,
        media_body=media,
    )

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            LOGGER.info(
                "Video %s upload progress: %.0f%%",
                video["id"],
                status.progress() * 100,
            )

    youtube_id = response.get("id") if response else None
    if not youtube_id:
        raise RuntimeError("YouTube returned no video ID")
    return str(youtube_id)


def mark_posted(supabase: Client, row_id: str, youtube_id: str) -> None:
    response = (
        supabase.table("videos")
        .update(
            {
                "posted": True,
                "posted_at": datetime.now(timezone.utc).isoformat(),
                "youtube_video_id": youtube_id,
            }
        )
        .eq("id", row_id)
        .execute()
    )
    if not response.data:
        raise RuntimeError(f"Supabase update affected no row for video {row_id}")


def record_history(
    supabase: Client,
    video: dict[str, Any],
    channel: dict[str, Any] | None,
    status: str,
    youtube_id: str | None = None,
    error_message: str | None = None,
) -> None:
    try:
        supabase.table("upload_history").insert(
            {
                "user_id": channel.get("user_id") if channel else video.get("user_id"),
                "video_id": video.get("id"),
                "channel_id": channel.get("id") if channel else None,
                "status": status,
                "youtube_video_id": youtube_id,
                "error_message": error_message[:2000] if error_message else None,
            }
        ).execute()
    except Exception:
        # History is supplementary; never turn a successful upload into a failure.
        LOGGER.exception("Could not record upload history for video %s", video.get("id"))


def main() -> int:
    args = parse_args()
    try:
        supabase = create_supabase_client()
        channel = get_active_channel(supabase)
        if channel:
            # Dashboard refresh tokens are issued to the Web OAuth client and
            # must be refreshed with that same client's credentials.
            youtube = create_youtube_client(
                channel["refresh_token"],
                required_env("GOOGLE_CLIENT_ID"),
                required_env("GOOGLE_CLIENT_SECRET"),
            )
        else:
            youtube = create_youtube_client()
        videos = get_pending_videos(
            supabase,
            args.count,
            repeat=args.repeat,
            owner_id=channel.get("user_id") if channel else None,
        )
    except Exception:
        LOGGER.exception("Could not initialize services or read the Supabase queue")
        return 1

    if not videos:
        LOGGER.info("No eligible videos found")
        return 0

    bucket = os.environ.get("SUPABASE_BUCKET", DEFAULT_BUCKET).strip() or DEFAULT_BUCKET
    failures = 0

    for video in videos:
        row_id = str(video.get("id", "<unknown>"))
        storage_path = str(video.get("storage_path") or "")
        temp_path: Path | None = None
        LOGGER.info("Processing video %s from %s", row_id, storage_path)
        try:
            if not storage_path:
                raise ValueError("storage_path is empty")
            temp_path = download_video(supabase, bucket, storage_path)
            youtube_id = upload_video(youtube, video, temp_path)
            # Persist immediately so a later failure cannot lose this upload state.
            mark_posted(supabase, row_id, youtube_id)
            if channel:
                supabase.table("youtube_channels").update(
                    {"last_used_at": datetime.now(timezone.utc).isoformat()}
                ).eq("id", channel["id"]).execute()
            record_history(supabase, video, channel, "success", youtube_id=youtube_id)
            LOGGER.info("Uploaded video %s successfully: YouTube ID %s", row_id, youtube_id)
        except Exception as exc:
            failures += 1
            record_history(supabase, video, channel, "failed", error_message=str(exc))
            LOGGER.exception("Video %s failed", row_id)
        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    LOGGER.exception("Could not remove temporary file for video %s", row_id)

    if failures:
        LOGGER.error("Batch finished with %d failure(s) out of %d video(s)", failures, len(videos))
        return 1
    LOGGER.info("Batch finished successfully: %d video(s) uploaded", len(videos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
