# Tumblr GIF Downloader

Paste a Tumblr post URL → the server fetches the page, finds all GIFs, and lets you download them with one click.

## Setup

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser.

## How it works

1. You paste a URL like `https://www.tumblr.com/mahlasv/820145826292760576`
2. The Node.js server fetches the Tumblr page (bypassing CORS)
3. It scrapes all `64.media.tumblr.com/*.gif` URLs from the HTML
4. The frontend shows previews with Download buttons
5. Clicking Download streams the GIF through `/api/download` so the file saves directly

## Project structure

```
gif-downloader/
├── server.js          # Express backend (fetch + scrape + proxy download)
├── package.json
└── public/
    └── index.html     # Frontend UI
```

## Notes

- Only works with **public** Tumblr blogs (private/NSFW-locked blogs return 403)
- Some posts use video (MP4) instead of GIF — those won't appear
- The `/api/download` endpoint only proxies `*.media.tumblr.com` URLs for security
