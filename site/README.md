# Afterhours landing page

A static page: `index.html`, `styles.css`, `main.js`, `config.js`, `favicon.svg`. No build step, no trackers, no external fonts.

## Before you deploy

1. Make the waitlist form. Use one of these:
   - [Formspree](https://formspree.io): create a form and put its URL in `waitlistEndpoint` in `config.js`. Sign-ups then stay on the page.
   - [Tally](https://tally.so): make a form and put its link in `waitlistUrl`. The button opens it in a new tab and passes the typed email as `?email=`; Tally saves it if the form has a hidden field named `email`.
2. Optional: set `contactEmail` in `config.js` for a contact line in the footer.

## Deploy

The page and `robots.txt` ask search engines to skip the site while the app is in development. When you launch, delete `robots.txt` and the `robots` meta tag in `index.html`.

- **Cloudflare Pages:** `npx wrangler pages deploy site --project-name afterhours`. Then add your domain under the project's Custom domains.
- **Vercel:** `npx vercel site --prod`.

## Preview locally

```sh
bunx serve site
```

Then open the address it prints, at phone width (390 px) and desktop width, in light and dark mode.

## Still to add

- A social preview image (`og.png`, 1200×630), referenced with `<meta property="og:image">`.
- The demo video (see `docs/demo-script.md`), in place of the phone mock or under it.
