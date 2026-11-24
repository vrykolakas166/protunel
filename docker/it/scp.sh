#!/bin/sh
# Keep the cancellation fixture in flight long enough to observe its staging file.
for arg do
    case "$arg" in
        */slow-copy.bin) exec /usr/bin/scp -l 1024 "$@" ;;
    esac
done
exec /usr/bin/scp "$@"
