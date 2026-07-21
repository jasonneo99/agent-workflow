# Truck Outfitters Unlimited Commands

Safe local checks:

```bash
node --check tools/crawl-wordpress-site.mjs
node --check tools/update-wordpress-media-metadata.mjs
```

Local static preview:

```bash
python3 -m http.server 8080
```

Use browser QA against the local preview before shipping visible site changes.
