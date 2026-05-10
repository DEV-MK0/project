#!/bin/bash
# start.sh

# Stop on first error
set -e

# Activate venv
source venv/bin/activate

# Go to project folder
cd "$(dirname "$0")"

# Start FastAPI app
uvicorn main-demo:app --host 0.0.0.0 --port 8000
