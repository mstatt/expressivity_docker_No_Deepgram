#!/bin/sh
# Starts the bot's runner (inside the container only) and nginx (port 9940).
# If either one exits, the container exits, so Docker can restart it.
set -eu

cd /app
python bot.py --host 127.0.0.1 --port 7860 &
BOT=$!

nginx -e stderr -c /etc/nginx/nginx.conf -g 'daemon off;' &
NGINX=$!

stop() {
    kill -TERM "$BOT" "$NGINX" 2>/dev/null || true
}
trap 'stop; wait; exit 0' TERM INT

echo "Expressivity: open http://localhost:9940 (ignore the runner's own :7860 address in the log)"

while kill -0 "$BOT" 2>/dev/null && kill -0 "$NGINX" 2>/dev/null; do
    sleep 1
done

echo "A process exited; stopping the container." >&2
stop
wait || true
exit 1
