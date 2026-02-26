#!/bin/bash

# Script to update GitHub Pages by copying files from src/www/ to docs/
# This allows GitHub Pages to serve the latest content from the docs/ directory

set -e  # Exit on any error

# Get the script's directory and navigate to project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC_DIR="$PROJECT_ROOT/src/www"
DEST_DIR="$PROJECT_ROOT/docs"

echo "==================================="
echo "Updating GitHub Pages"
echo "==================================="
echo "Source:      $SRC_DIR"
echo "Destination: $DEST_DIR"
echo ""

# Check if source directory exists
if [ ! -d "$SRC_DIR" ]; then
    echo "Error: Source directory '$SRC_DIR' does not exist!"
    exit 1
fi

# Create destination directory if it doesn't exist
if [ ! -d "$DEST_DIR" ]; then
    echo "Creating destination directory..."
    mkdir -p "$DEST_DIR"
fi

# Remove old files in destination (except .git if present)
echo "Cleaning destination directory..."
find "$DEST_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

# Copy all files from source to destination
echo "Copying files..."
cp -r "$SRC_DIR"/* "$DEST_DIR"/

echo ""
echo "==================================="
echo "✓ GitHub Pages update complete!"
echo "==================================="
echo ""
echo "Files have been copied to $DEST_DIR"
echo "Don't forget to commit and push the changes to deploy to GitHub Pages."
