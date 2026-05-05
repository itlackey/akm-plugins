#!/usr/bin/env sh

exec bun "$(dirname "$0")/akm-hook.ts" "$@"
