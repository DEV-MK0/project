#!/bin/bash
# start.sh

# Stop on first error
set -e

# Activate venv
source ~/Documents/GitHub/venv/bin/activate

# Go to project folder
cd "$(dirname "$0")"

# Start FastAPI app
uvicorn main:app --reload --host 0.0.0.0 --port 8000
