---
title: Custom Domains
description: Serve each status page on its own hostname from a single Kener instance
---

Bind a hostname to a status page and Kener serves that page at the domain's root. One instance can answer for several domains, each showing a different page.

## Add a domain {#add-a-domain}

1. Go to **Pages**, open the page, and find **Custom Domains**.
2. Enter the hostname (for example `status.example.com`) and select **Add**. It starts as **pending**.
3. Point the hostname at your instance with a `CNAME` (or an `A` record).
4. Route the hostname to Kener in your reverse proxy. See below.
5. Return to the page and select **Activate**.

A pending domain never serves, so a hostname whose DNS is not ready yet cannot start answering for a page.

## Primary domain {#primary-domain}

A page can have several domains. The **primary** one is used to build that page's absolute links: its RSS feed, its sitemap, its social preview tags, and the entry other pages' switchers link to. Select **Make primary** on the domain you want.

## Reverse proxy {#reverse-proxy}

> [!IMPORTANT]
> Kener does not obtain TLS certificates. Terminate TLS at your reverse proxy and forward to the container.

Two headers matter:

- **`Host`** must be passed through unchanged. It is how Kener decides which page to serve.
- **`X-Forwarded-Proto`** should be set, or absolute links will use `http://`.

### Caddy {#caddy}

Caddy obtains certificates automatically for every hostname you list, and passes both headers by default.

```caddyfile
status.example.com, status.acme.com {
    reverse_proxy kener:3000
}
```

### Traefik {#traefik}

```yaml
labels:
    - "traefik.enable=true"
    - "traefik.http.routers.kener.rule=Host(`status.example.com`) || Host(`status.acme.com`)"
    - "traefik.http.routers.kener.tls.certresolver=letsencrypt"
    - "traefik.http.services.kener.loadbalancer.server.port=3000"
```

### nginx {#nginx}

```nginx
server {
    server_name status.example.com status.acme.com;
    location / {
        proxy_pass http://kener:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## How it resolves {#how-it-resolves}

| Request                             | Serves                           |
| ----------------------------------- | -------------------------------- |
| A hostname bound to a page          | That page, at `/`                |
| A hostname bound to an organization | That organization, normal paths  |
| Anything else                       | The home page, exactly as before |

> [!NOTE]
> API requests are unaffected. An API key always addresses its own organization, whichever hostname the request arrived on: for public traffic the hostname identifies the tenant, but for API traffic the key does.

Changes take up to a minute to take effect, because hostname bindings are cached.

## Troubleshooting {#troubleshooting}

**The domain shows the home page instead of my page.**
It is still pending, or the proxy is not passing `Host` through. Check both.

**Links in the RSS feed point at the wrong domain.**
The page has no primary domain set, so links fall back to the site address in [Site Configuration](/docs/v4/setup/site-configuration).

**Links use `http://` on an HTTPS site.**
The proxy is not sending `X-Forwarded-Proto`.

**"That hostname is already in use".**
A hostname can belong to only one page or organization across the whole instance.
