#!/bin/sh
exec /usr/bin/arch -arm64 -x86_64 "$BENCH_BROWSER" "$@"
