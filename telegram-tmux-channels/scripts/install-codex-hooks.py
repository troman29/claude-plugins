#!/usr/bin/env python3
"""Разложить хуки плагина в пользовательский слой Codex (`~/.codex/hooks.json`).

Claude Code берёт хуки из самого плагина, Codex так не умеет — ему нужен файл в своём конфиге,
с УЖЕ подставленными абсолютными путями. Без него Codex не шлёт `Stop`, хаб не узнаёт о конце
хода, и ответ агента не уходит в Telegram: в чате тишина, а в пейне всё написано (2026-08-17).

Идемпотентно: повторный запуск перезаписывает файл тем же содержимым. После первого запуска
Codex один раз спросит «Hooks need review» — это его штатная проверка доверия, ответить надо
«Trust all and continue», иначе хуки не выполняются.

    python3 scripts/install-codex-hooks.py [--plugin-root DIR] [--out FILE]
"""
import argparse
import copy
import json
import os
import shutil
import sys

TOKENS = ("${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}")


def materialize(raw_hooks: dict, plugin_root: str, bun: str) -> dict:
    """Подставить пути: плагин-рут вместо плейсхолдеров, абсолютный bun вместо голого `bun`."""
    hooks = copy.deepcopy(raw_hooks)
    for entries in hooks.values():
        for entry in entries:
            for h in entry.get("hooks", []):
                if h.get("type") != "command":
                    continue
                cmd = h["command"]
                for token in TOKENS:
                    cmd = cmd.replace(token, plugin_root)
                if cmd.startswith("bun "):
                    cmd = bun + cmd[3:]
                h["command"] = cmd
    return hooks


def main() -> int:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument("--plugin-root", default=here)
    ap.add_argument("--out", default=os.path.expanduser("~/.codex/hooks.json"))
    args = ap.parse_args()

    src = os.path.join(args.plugin_root, "hooks", "hooks.json")
    if not os.path.exists(src):
        print(f"нет {src}", file=sys.stderr)
        return 1
    # Полный путь к bun: хуки запускает Codex, а его PATH — не наш логин-шелл.
    bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
    hooks = materialize(json.load(open(src))["hooks"], args.plugin_root, bun)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({"description": "telegram-tmux-channels hooks (Codex user layer)", "hooks": hooks}, f, indent=2)
    print(f"{args.out}: {sum(len(v) for v in hooks.values())} записей, события: {', '.join(hooks)}")
    return 0


def _selftest() -> None:
    raw = {"Stop": [{"hooks": [{"type": "command", "command": "bun ${CLAUDE_PLUGIN_ROOT}/src/x.ts"}]}]}
    got = materialize(raw, "/plug", "/b/bun")["Stop"][0]["hooks"][0]["command"]
    assert got == "/b/bun /plug/src/x.ts", got
    # чужие команды не трогаем, плейсхолдер всё равно раскрываем
    raw2 = {"Stop": [{"hooks": [{"type": "command", "command": "python3 ${PLUGIN_ROOT}/y.py"}]}]}
    assert materialize(raw2, "/plug", "/b/bun")["Stop"][0]["hooks"][0]["command"] == "python3 /plug/y.py"
    print("selftest ok")


if __name__ == "__main__":
    sys.exit(_selftest() if "--selftest" in sys.argv else main())
