# Re-rendering the walkthrough

The video is rendered from `scripts/walkthrough/how-mainworks-works.html`. After editing it, with Playwright Chromium, ffmpeg and uv installed:

```sh
frames=$(mktemp -d)
node scripts/walkthrough/render.mjs "$PWD/scripts/walkthrough/how-mainworks-works.html" "$frames" 10
ffmpeg -y -framerate 10 -i "$frames/f%05d.png" -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags +faststart docs/diagrams/how-mainworks-works.mp4
uv run --no-project --with pillow python -I scripts/walkthrough/makegif.py "$frames" 10 800 docs/diagrams/how-mainworks-works.gif
```
