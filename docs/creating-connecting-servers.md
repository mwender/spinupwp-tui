# Creating & connecting servers

Two write actions on the **Servers** tab that stand up a new server and make it
usable — both **need a Read/Write token**.

**Create a server (`c`).** Opens a form pre-filled to **match** the selected
server's provider, region, and size (or from scratch on an empty fleet). It prices
the build from the provider's catalog (DigitalOcean / Vultr / Linode / Hetzner),
suggests a hostname from your fleet's naming convention, and lets you switch
provider (`p`), region (`g`), or size (`e`) and toggle backups (`b`) before
confirming. Because the SpinupWP API can't list your configured server providers,
the first time you build on a provider the overlay asks for its SpinupWP provider
id (Account Settings → Server Providers) and saves it — once per provider. The
build fires `POST /servers` and tracks the ~10-minute provision in the background.

**Connect it with a vanity site (`V`).** A brand-new server has **no site**, so
there's nothing to attach an SSH key to and no way for SpinupTUI to reach it — empty
servers are flagged in **amber** in the Servers list. A busy server benefits from
the same thing (a status page at its own hostname + a site user to hold your key),
so `V` is offered on **any server that doesn't yet have a site at its own
hostname** — it also appears under **Manage** in the server's Details panel. It
builds the small placeholder ("vanity") site end to end:

1. **DNS** — writes an `A` record for the hostname → the server IP (AWS Route 53),
   using the connection from the DNS module.
2. **Propagate** — waits for the record to resolve (so Let's Encrypt can issue);
   after ~2 minutes it offers to skip SSL for now or keep waiting.
3. **Site** — creates a blank site (`installation_method: "blank"`).
4. **HTTPS** — enables a free Let's Encrypt certificate.
5. **SSH key** — deep-links you to the site's **SFTP & SSH → Site User** to add
   your key (the API can't do this), then waits for you to confirm.
6. **Publish** — seeds a minimal, brand-neutral status page (it reads its own
   hostname, so it's reusable on any server). Press `o` to open the live site.

The whole build is a **resumable background job**: close the overlay and a header
badge keeps tracking it; press `V` on the server to reopen it (even after the site
exists). It survives quitting and relaunching the app. If a step fails, the overlay
shows where, with `r` to retry or `x` to discard.
