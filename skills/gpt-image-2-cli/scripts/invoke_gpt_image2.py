#!/usr/bin/env python3
"""Portable gpt-image-2 helper for Codex skill environments."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


def user_path(value: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(value)))


def resolve_existing_dir(value: str, label: str) -> Path:
    path = user_path(value).resolve()
    if not path.is_dir():
        raise SystemExit(f"{label} does not exist or is not a directory: {path}")
    return path


def resolve_codex_home(explicit_path: str | None) -> Path:
    if explicit_path:
        return resolve_existing_dir(explicit_path, "Codex home")

    env_path = os.environ.get("CODEX_HOME")
    if env_path:
        return resolve_existing_dir(env_path, "CODEX_HOME")

    home = Path.home()
    if not home:
        raise SystemExit("Cannot resolve Codex home. Set CODEX_HOME or pass --codex-home.")

    return home / ".codex"


def read_auth_api_key(codex_home: Path) -> str:
    env_key = os.environ.get("OPENAI_API_KEY")
    if env_key:
        return env_key

    auth_path = codex_home / "auth.json"
    if not auth_path.is_file():
        raise SystemExit(f"OPENAI_API_KEY is not set and auth.json was not found at {auth_path}.")

    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Could not parse {auth_path}: {exc}") from exc

    key = auth.get("OPENAI_API_KEY") or auth.get("openai_api_key")
    if key:
        return str(key)

    raise SystemExit(f"auth.json exists at {auth_path} but does not contain OPENAI_API_KEY.")


def first_base_url(config: dict[str, Any]) -> str | None:
    provider_name = config.get("model_provider")
    providers = config.get("model_providers")

    if isinstance(providers, dict):
        if isinstance(provider_name, str):
            selected = providers.get(provider_name)
            if isinstance(selected, dict) and isinstance(selected.get("base_url"), str):
                return selected["base_url"]

        for provider_config in providers.values():
            if isinstance(provider_config, dict) and isinstance(provider_config.get("base_url"), str):
                return provider_config["base_url"]

    if isinstance(config.get("base_url"), str):
        return config["base_url"]

    return None


def read_config_base_url_with_tomllib(config_path: Path) -> str | None:
    try:
        import tomllib
    except ModuleNotFoundError:
        return None

    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    return first_base_url(config)


def strip_toml_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return value[1:-1]
    return value


def read_config_base_url_fallback(config_path: Path) -> str | None:
    lines = config_path.read_text(encoding="utf-8").splitlines()
    provider = None

    for line in lines:
        match = re.match(r"\s*model_provider\s*=\s*(.+?)\s*(?:#.*)?$", line)
        if match:
            provider = strip_toml_quotes(match.group(1))
            break

    section = ""
    fallback = None
    for line in lines:
        section_match = re.match(r"\s*\[([^\]]+)\]\s*$", line)
        if section_match:
            section = section_match.group(1).replace('"', "").replace("'", "")
            continue

        base_url_match = re.match(r"\s*base_url\s*=\s*(.+?)\s*(?:#.*)?$", line)
        if not base_url_match:
            continue

        value = strip_toml_quotes(base_url_match.group(1))
        if provider and section == f"model_providers.{provider}":
            return value
        if fallback is None:
            fallback = value

    return fallback


def read_config_base_url(codex_home: Path) -> str | None:
    config_path = codex_home / "config.toml"
    if not config_path.is_file():
        return None

    return read_config_base_url_with_tomllib(config_path) or read_config_base_url_fallback(config_path)


def resolve_imagegen_cli(codex_home: Path, explicit_path: str | None) -> Path:
    if explicit_path:
        path = user_path(explicit_path).resolve()
    else:
        path = codex_home / "skills" / ".system" / "imagegen" / "scripts" / "image_gen.py"

    if not path.is_file():
        raise SystemExit(f"Bundled imagegen CLI was not found: {path}")

    return path


def model_slug(model: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", model).strip("-") or "image"


def resolve_output_path(out: str | None, model: str) -> Path:
    if out:
        path = user_path(out)
    else:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = Path.cwd() / "output" / "imagegen" / f"{model_slug(model)}-{stamp}.png"

    if not path.is_absolute():
        path = Path.cwd() / path

    return path.resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate an image through the Codex imagegen CLI with gpt-image-2.")
    parser.add_argument("--prompt", required=True, help="Final image prompt.")
    parser.add_argument("--out", help="Output PNG path. Defaults to output/imagegen/<model>-<timestamp>.png.")
    parser.add_argument("--size", default="1536x1024", help="Image size, for example auto, 1024x1024, or 1536x1024.")
    parser.add_argument("--quality", choices=("low", "medium", "high", "auto"), default="high")
    parser.add_argument("--model", default="gpt-image-2")
    parser.add_argument("--codex-home", help="Codex home directory. Defaults to CODEX_HOME or ~/.codex.")
    parser.add_argument("--imagegen-cli", help="Path to image_gen.py. Defaults to ~/.codex/skills/.system/imagegen/scripts/image_gen.py.")
    parser.add_argument("--base-url", help="Override OPENAI_BASE_URL for this run.")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing output path.")
    parser.add_argument("--dry-run", action="store_true", help="Print API payload without calling the API.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    codex_home = resolve_codex_home(args.codex_home)
    imagegen_cli = resolve_imagegen_cli(codex_home, args.imagegen_cli)
    out_path = resolve_output_path(args.out, args.model)

    if out_path.exists() and not args.force:
        raise SystemExit(f"Output already exists: {out_path}. Use --force to overwrite or choose another --out path.")

    out_path.parent.mkdir(parents=True, exist_ok=True)

    child_env = os.environ.copy()
    child_env["OPENAI_API_KEY"] = read_auth_api_key(codex_home)

    if args.base_url:
        child_env["OPENAI_BASE_URL"] = args.base_url
    else:
        config_base_url = read_config_base_url(codex_home)
        if config_base_url:
            child_env["OPENAI_BASE_URL"] = config_base_url

    cli_args = [
        sys.executable,
        str(imagegen_cli),
        "generate",
        "--model",
        args.model,
        "--quality",
        args.quality,
        "--size",
        args.size,
        "--output-format",
        "png",
        "--prompt",
        args.prompt,
        "--out",
        str(out_path),
    ]

    if args.force:
        cli_args.append("--force")

    if args.dry_run:
        cli_args.append("--dry-run")

    completed = subprocess.run(cli_args, env=child_env, check=False)
    if completed.returncode != 0:
        return completed.returncode

    print(f"OUT_PATH={out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
