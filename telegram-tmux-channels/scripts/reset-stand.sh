#!/usr/bin/env bash
# Сбросить стенд в состояние «первого запуска», НЕ трогая учётки.
#
# Зачем: стенд живёт неделями и давно ответил на все первичные вопросы — доверие каталогу,
# доверие хукам, установка плагина. Свежая машина и свежий топик по ним ходят, а стенд нет,
# и поломки первого запуска на нём невидимы. 2026-08-17 так прошли три подряд.
#
# Полный `down -v` не годится: том несёт авторизацию Claude и Codex, а логин интерактивный.
# Поэтому чистим только состояние: гейты доверия, биндинги, tmux, стейт хаба.
#
#   bash scripts/reset-stand.sh [контейнер]
set -euo pipefail
C="${1:-claude-tmux}"

docker exec "$C" bash -lc '
set -e
# скобка в шаблоне, иначе pkill матчит собственную команду и убивает сам себя
pkill -f "[b]un run src/hub.ts" 2>/dev/null || true
tmux kill-server 2>/dev/null || true

python3 - <<PY
import json, os, re

home = os.path.expanduser("~")
done = []

# 1. Стейт хаба: карта топиков, пикеры, известные чаты. .env НЕ трогаем — там токен бота.
ch = os.path.join(home, ".claude/channels/telegram")
for name in ("bindings.json", "hub-state.json", "known-chats.json", "topic-names.json"):
    p = os.path.join(ch, name)
    if os.path.exists(p):
        os.remove(p); done.append(name)

# 2. Доверие Codex: каталогам и хукам. auth.json остаётся — это учётка.
cfg = os.path.join(home, ".codex/config.toml")
if os.path.exists(cfg):
    src = open(cfg).read()
    out = re.sub(r"\[projects\.[^\]]+\]\ntrust_level = \"trusted\"\n\n?", "", src)
    out = re.sub(r"^trusted_hash = .*\n", "", out, flags=re.M)
    out = re.sub(r"\[hooks\.trust[^\]]*\]\n(?:(?!\[)[^\n]*\n)*", "", out)
    if out != src:
        open(cfg, "w").write(out); done.append("codex: доверие каталогам и хукам")

# 3. Доверие Claude каталогам: в том же файле, что и учётка, — вырезаем только проекты.
cj = os.path.join(home, ".claude.json")
if os.path.exists(cj):
    d = json.load(open(cj))
    if d.pop("projects", None) is not None:
        json.dump(d, open(cj, "w"), indent=2); done.append("claude: доверие каталогам")

print("сброшено: " + (", ".join(done) if done else "нечего было"))
PY
'
echo "стенд сброшен; хаб и tmux погашены — поднимутся при первом обращении или запусти хаб вручную"
