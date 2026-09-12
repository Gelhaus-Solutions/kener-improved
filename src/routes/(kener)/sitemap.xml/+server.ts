import { GetSiteDataByKey } from "$lib/server/controllers/siteDataController.js";
import { GetAllPages } from "$lib/server/controllers/pagesController.js";
import { GetMonitors } from "$lib/server/controllers/monitorsController.js";
import serverResolver from "$lib/server/resolver.js";
import type { SitemapXMLConfig } from "$lib/types/site.js";
import type { RequestHandler } from "./$types";
import { publicBaseUrlFromRequest } from "$lib/server/http/publicUrl.js";

export const GET: RequestHandler = async ({ request, locals }) => {
  const sitemap = (await GetSiteDataByKey("sitemap")) as SitemapXMLConfig | null;
  const mode = sitemap?.mode ?? "auto";

  if (mode === "off") {
    return new Response("Not found", { status: 404 });
  }

  if (mode === "manual") {
    const urls = sitemap?.urls ?? [];
    const urlEntries = urls
      .filter((u) => u.loc.trim().length > 0)
      .map((u) => `  <url>\n    <loc>${escapeXml(u.loc.trim())}</loc>\n  </url>`)
      .join("\n");

    return sitemapResponse(urlEntries);
  }

  // auto mode
  //
  // G4. Built from the host this sitemap was fetched on, falling back to the
  // configured `siteURL`. A sitemap listing another domain's URLs is worse than
  // no sitemap: search engines treat cross-domain entries as unverifiable and
  // may ignore the file entirely.
  const siteURL = publicBaseUrlFromRequest(request, (await GetSiteDataByKey("siteURL")) as string | null);
  if (!siteURL) {
    return new Response("Not found", { status: 404 });
  }

  const locs: string[] = [];

  // G4. On a hostname bound to one page, that page IS the site: listing the
  // instance's other pages under this domain would advertise URLs that serve
  // somebody else's status page.
  const boundPagePath = locals.pagePath;
  const pages = await GetAllPages();
  for (const page of pages) {
    if (boundPagePath !== undefined && page.page_path !== boundPagePath) continue;
    const path = boundPagePath !== undefined ? "/" : page.page_path ? `/${page.page_path}` : "/";
    locs.push(siteURL + serverResolver(path));
  }

  // Add active, visible monitors
  //
  // **The slug, not the tag** (I3e). A public URL carries the per-org slug so a
  // tenant's visitors never see another tenant's prefix, and a sitemap is the
  // one place where getting that wrong is durable: these are the URLs search
  // engines index and then keep serving. The tag remains the fallback for a row
  // whose slug was never filled in, which is what `ResolvePublicMonitor` accepts
  // anyway. A no-op on the default org, whose slug and tag are identical.
  const monitors = await GetMonitors({ status: "ACTIVE", is_hidden: "NO" });
  for (const monitor of monitors) {
    locs.push(siteURL + serverResolver(`/monitors/${monitor.slug || monitor.tag}`));
  }

  // Add current and previous month events pages
  const now = new Date();
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const currentMonth = `${months[now.getUTCMonth()]}-${now.getUTCFullYear()}`;
  const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousMonth = `${months[prevDate.getUTCMonth()]}-${prevDate.getUTCFullYear()}`;
  locs.push(siteURL + serverResolver(`/events/${currentMonth}`));
  locs.push(siteURL + serverResolver(`/events/${previousMonth}`));

  // Add any manual URLs configured alongside auto
  const manualUrls = sitemap?.urls ?? [];
  for (const u of manualUrls) {
    if (u.loc.trim().length > 0) {
      locs.push(u.loc.trim());
    }
  }

  const urlEntries = locs.map((loc) => `  <url>\n    <loc>${escapeXml(loc)}</loc>\n  </url>`).join("\n");

  return sitemapResponse(urlEntries);
};

function sitemapResponse(urlEntries: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml",
    },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
