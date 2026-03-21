#!/bin/bash
cd "$(dirname "$0")"
echo "Installing dependencies..."
npm install
echo ""
echo "Starting Hotel Researcher API on port 5555..."
node server.js
