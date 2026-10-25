#!/bin/bash
# Stop hook: Quick build check after Claude finishes a response
# Only runs if shader, stage or scene-build files were modified in this session

cd /Users/atulkumar/RayTracing

# Check if any core rendering files have uncommitted changes
CHANGED=$(git diff --name-only 2>/dev/null | grep -E "rayzee/src/(shaders|pathtracer|pipeline|scene|bvh)/" | head -1)

if [ -n "$CHANGED" ]; then
  # Quick syntax-only build check (timeout after 15s)
  RESULT=$(timeout 15s npx vite build --mode development 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "Build check failed after editing core files:"
    echo "$RESULT" | tail -5
  fi
fi

exit 0
