const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Headers to mimic a real browser visit
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

/**
 * Extract GIF URLs from Tumblr HTML.
 * Tries multiple strategies in order of reliability.
 */
function extractGifUrls(html) {
  const gifs = new Set();

  // Strategy 1: 64.media.tumblr.com GIF URLs (most reliable — direct CDN)
  const cdnGifs = html.match(/https:\/\/64\.media\.tumblr\.com\/[a-zA-Z0-9_\/.\-?=&%]+\.gif[^"'\s<>]*/g);
  if (cdnGifs) cdnGifs.forEach(u => gifs.add(u.split('"')[0].split("'")[0]));

  // Strategy 2: Any tumblr media URL ending in .gif
  const mediaGifs = html.match(/https:\/\/[a-z0-9]+\.media\.tumblr\.com\/[^"'\s<>]+\.gif[^"'\s<>]*/g);
  if (mediaGifs) mediaGifs.forEach(u => gifs.add(u.split('"')[0].split("'")[0]));

  // Strategy 3: og:image meta tag (often points to preview, but sometimes the gif)
  const ogMatch = html.match(/property=["']og:image["'][^>]*content=["']([^"']+\.gif[^"']*)["']/i)
                || html.match(/content=["']([^"']+\.gif[^"']*)["'][^>]*property=["']og:image["']/i);
  if (ogMatch) gifs.add(ogMatch[1]);

  // Strategy 4: JSON data embedded in <script> tags (Tumblr SSR state)
  const jsonBlocks = html.match(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonBlocks) {
    const urls = block.match(/https:\\\/\\\/64\.media\.tumblr\.com\\\/[^"'\\]+\.gif/g);
    if (urls) urls.forEach(u => gifs.add(u.replace(/\\\//g, '/')));
  }

  // Strategy 5: escaped URLs in inline scripts
  const escaped = html.match(/https:\\u002F\\u002F64\.media\.tumblr\.com\\u002F[^"'\\]+\.gif/g);
  if (escaped) escaped.forEach(u => gifs.add(decodeURIComponent(u.replace(/\\u002F/g, '/'))));

  return [...gifs].filter(u => u.startsWith('http'));
}

/**
 * POST /api/extract
 * Body: { url: "https://www.tumblr.com/blog/postid" }
 * Returns: { gifs: ["https://...gif", ...] }
 */
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'No URL provided.' });
  }

  // Validate it looks like a Tumblr post URL
  const tumblrPattern = /^https?:\/\/(www\.)?tumblr\.com\/[^\/]+\/\d+/;
  if (!tumblrPattern.test(url)) {
    return res.status(400).json({ error: 'URL must be a Tumblr post link, e.g. https://www.tumblr.com/blog/123456789' });
  }

  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 15000,
      maxRedirects: 5,
    });

    const html = response.data;
    const gifs = extractGifUrls(html);

    if (gifs.length === 0) {
      return res.status(404).json({ error: 'No GIFs found in this post. Make sure the post contains an animated GIF (not a video or static image).' });
    }

    return res.json({ gifs });

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Post not found. Check that the URL is correct and the blog is public.' });
    }
    if (err.response?.status === 403) {
      return res.status(403).json({ error: 'Tumblr blocked the request. The blog may be private or age-restricted.' });
    }
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request timed out. Try again in a moment.' });
    }
    console.error('Extract error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch the post. ' + (err.message || '') });
  }
});

/**
 * GET /api/download?url=...
 * Proxies the GIF through the server so the browser can download it
 * without CORS issues.
 */
app.get('/api/download', async (req, res) => {
  const { url } = req.query;

  if (!url || !url.startsWith('https://')) {
    return res.status(400).send('Invalid URL');
  }

  // Only allow Tumblr CDN domains
  const allowed = /^https:\/\/(64\.media|[a-z0-9]+\.media)\.tumblr\.com\//;
  if (!allowed.test(url)) {
    return res.status(403).send('Only Tumblr CDN URLs are allowed.');
  }

  try {
    const upstream = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Referer': 'https://www.tumblr.com/',
      },
      timeout: 30000,
    });

    const filename = url.split('/').pop().split('?')[0] || 'download.gif';
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/gif');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    upstream.data.pipe(res);

  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).send('Failed to download GIF.');
  }
});

app.listen(PORT, () => {
  console.log(`GIF Downloader running at http://localhost:${PORT}`);
});
