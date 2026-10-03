/**
 * Probe for the Image API 3.0 tile-source shim (src/main/web/data/iiif/ImageApiCompat.ts) on Mirador 2's
 * bundled OpenSeadragon 2.4.1, which is what renders external IIIF images in RS.
 *
 * Two kinds of target:
 * - `mirador`: an image or region in the store, opened in the image-annotation view (the real path).
 * - `osd`: a service that is not in the store, opened with the page's global OpenSeadragon 2.4.1 (the
 *   copy Mirador uses, shimmed) in a viewer the probe adds over a stored image's page; it zooms to the
 *   deepest level once open.
 *
 * Targets are labelled by what they are, not by version: the probe reads every info.json the browser
 * receives and prints what it serves (Image API version, level, `id`/`@id`, whether `@id` is the
 * requested id or a re-encoded spelling of it). For each target it then prints the tile requests by size
 * form and status, the id the tiles were requested under, and page errors.
 *
 * Expected: 3.0 services load with `w,h` / `max` sizes and no 4xx; 2.x services keep `w,` sizes; tiles go
 * to the requested (stored) id; no "IIIF required parameters not provided". Reports, never asserts.
 *
 *   npm run probe -- iiif-image-api-3            all targets
 *   ONLY=static npm run probe -- iiif-image-api-3  targets whose label contains "static"
 *
 * Load on remote servers: one page per target, ~20 s of tiles; the `osd` targets add one zoom-in.
 */
import { test, Page } from '@playwright/test';

const R = 'https://w3id.org/murtenpanorama/resource';
type Target = { label: string; kind: 'mirador' | 'osd'; service: string; iri?: string };
const TARGETS: Target[] = [
  {
    label: 'e-codices 767 region (www.e-codices.unifr.ch)',
    kind: 'mirador',
    iri: `${R}/ImageRegion/3769eed8-8723-4713-8c84-7a9894e192ba`,
    service: 'https://www.e-codices.unifr.ch/loris/bbb/bbb-Mss-hh-I0003/bbb-Mss-hh-I0003_767.jp2',
  },
  {
    label: 'e-codices 225v image (e-codices.ch)',
    kind: 'mirador',
    iri: `${R}/image/a0c2ced1-9c83-46be-aa3e-c18a29360fe8`,
    service: 'https://e-codices.ch/loris/kba/kba-Ms-ZF-0018/kba-Ms-ZF-0018_225v.jp2',
  },
  {
    label: 'Royal Armouries image (id only)',
    kind: 'mirador',
    iri: `${R}/image/465ac396-dbd9-4ac8-867f-56ffbe2fe8b8`,
    service: 'https://collections.armouries.net/iiif/3/aetopia/73/472/DI_2013_0869.ptif',
  },
  {
    label: 'terapixel image',
    kind: 'mirador',
    iri: `${R}/image/5d0bdf04-29c4-4808-bc81-a795f4bb460f`,
    service: 'https://scholar.terapixelpanorama.ch/iiif/part123_decurve_align_crop_20240620_75_512.tif',
  },
  {
    label: 'BSB image',
    kind: 'mirador',
    iri: `${R}/image/f5c0a1a1-0dc0-41e7-bc49-09aa0405e8bc`,
    service: 'https://api.digitale-sammlungen.de/iiif/image/v2/bsb11327719_00360',
  },
  {
    label: 'IIIF 3.0 reference service',
    kind: 'osd',
    service: 'https://iiif.io/api/image/3.0/example/reference/918ecd18c2592080851777620de9bcb5-gottingen',
  },
  {
    // RA2's `vips dzsave --layout iiif3` pyramid, served by dev. Its info.json carries a fixed
    // http://localhost:10214 id; the probe rewrites that id to its own base URL, where the login cookie is
    label: 'static level0 pyramid (dev)',
    kind: 'osd',
    service: '/assets/km-annotorious/iiif3-static/book3',
  },
];
const ONLY = process.env.ONLY;
const HOST_PAGE = `${R}/image/f5c0a1a1-0dc0-41e7-bc49-09aa0405e8bc`;

/** Reads what an info.json serves, independent of what the target is called. */
function describeInfo(requested: string, info: any): string {
  const contexts = ([] as unknown[]).concat(info['@context'] ?? []).map(String);
  const version =
    contexts.some((c) => c.includes('/image/3/')) || info.type === 'ImageService3'
      ? '3.0'
      : contexts.some((c) => c.includes('/image/2/'))
      ? '2.x'
      : contexts.some((c) => c.includes('1.1') || c.includes('/image/1/'))
      ? '1.x'
      : `unknown (${contexts.join(' ')})`;
  const profile = ([] as unknown[]).concat(info.profile ?? [])[0];
  const level = String(profile ?? '?').match(/level\d/)?.[0] ?? String(profile);
  const idKey = info['@id'] !== undefined ? '@id' : info.id !== undefined ? 'id' : 'none';
  const id = String(info['@id'] ?? info.id ?? '');
  const spelling =
    id === requested
      ? 'the requested id'
      : decodeURIComponent(id) === decodeURIComponent(requested)
      ? `the requested id re-encoded: ${id}`
      : `another id: ${id}`;
  const tiles = (info.tiles ?? []).map((t: any) => `${t.width}${t.height ? 'x' + t.height : ''}`).join('/') || 'none';
  return `Image API ${version}, ${level}${
    info.type ? `, type ${info.type}` : ''
  }, ${idKey} = ${spelling}, tiles ${tiles}, sizes ${(info.sizes ?? []).length}`;
}

async function probe(page: Page, baseURL: string, target: Target) {
  const t = { ...target, service: target.service.startsWith('/') ? baseURL + target.service : target.service };
  const errors: string[] = [];
  const infos: Record<string, number> = {};
  const tiles: { status: number; size: string; base: string; url: string }[] = [];
  const others: Record<string, number> = {};
  // the service host, plus the host of any id an info.json names (tiles follow the served id)
  const hosts = new Set([new URL(t.service).host]);
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  // records the exact URLs OpenSeadragon asks for, to tell its tiles from RS's own thumbnails of the same image
  await page.addInitScript(() => {
    const w = window as any;
    w.__osdTileUrls = [];
    const timer = setInterval(() => {
      const proto = w.OpenSeadragon?.IIIFTileSource?.prototype;
      if (!proto || !proto.__imageApi3Shim || proto.__probeWrapped) return;
      const getTileUrl = proto.getTileUrl;
      proto.getTileUrl = function () {
        const url = getTileUrl.apply(this, arguments);
        w.__osdTileUrls.push(url);
        return url;
      };
      proto.__probeWrapped = true;
      clearInterval(timer);
    }, 50);
  });
  if (target.service.startsWith('/')) {
    await page.route(`${t.service}/info.json`, async (route) => {
      const response = await route.fetch();
      const info = await response.json();
      info.id = t.service;
      await route.fulfill({ response, json: info });
    });
  }
  const responses: { status: number; url: string }[] = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (u.endsWith('/info.json') && u.startsWith(t.service)) {
      let served = '';
      try {
        const info = await r.json();
        served = describeInfo(t.service, info);
        const id = info['@id'] ?? info.id;
        if (typeof id === 'string') hosts.add(new URL(id).host);
      } catch (e) {
        served = `unreadable (${String(e).slice(0, 80)})`;
      }
      const line = `${r.status()} ${u}\n      serves: ${served}`;
      infos[line] = (infos[line] ?? 0) + 1;
    } else if (r.request().resourceType() === 'image') {
      responses.push({ status: r.status(), url: u });
    }
  });
  const classify = async () => {
    const osdUrls = new Set<string>(await page.evaluate(() => (window as any).__osdTileUrls ?? []));
    for (const { status, url: u } of responses) {
      if (![...hosts].some((h) => new URL(u).host === h)) continue;
      if (!osdUrls.has(u)) {
        const key = `${u.split('/').slice(-4, -2).join('/')} ${status}`;
        others[key] = (others[key] ?? 0) + 1;
        continue;
      }
      // {service}/{region}/{size}/{rotation}/{quality}.{format}
      const parts = u.split('/');
      tiles.push({ status, size: parts[parts.length - 3], base: parts.slice(0, -4).join('/'), url: u });
    }
  };

  const frame = `${baseURL}/resource/?uri=${encodeURIComponent(
    'http://www.researchspace.org/resource/ThinkingFrames'
  )}`;
  let mounted = true;
  if (t.kind === 'mirador') {
    // the "Image annotations" frame of the ThinkingFrames dashboard, as opened from a resource's actions
    await page.goto(`${frame}&view=image-annotation&resource=${encodeURIComponent(t.iri!)}`, {
      waitUntil: 'domcontentloaded',
    });
    try {
      await page.waitForSelector('.mirador-osd canvas', { timeout: 90_000 });
    } catch {
      mounted = false;
    }
  } else {
    // Mirador's module installs the shimmed 2.4.1 global; it loads only when the view has an image to show, so
    // the probe's viewer is hosted on the BSB image's page (its tiles are on another host and are not counted)
    await page.goto(`${frame}&view=image-annotation&resource=${encodeURIComponent(HOST_PAGE)}`, {
      waitUntil: 'domcontentloaded',
    });
    try {
      await page.waitForFunction(() => !!(window as any).OpenSeadragon?.IIIFTileSource, null, { timeout: 90_000 });
      mounted = await page.evaluate(async (service) => {
        const osd = (window as any).OpenSeadragon;
        const element = document.createElement('div');
        element.id = 'probe-osd';
        element.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:99999;background:#000';
        document.body.appendChild(element);
        const viewer = osd({ element, tileSources: `${service}/info.json`, showNavigationControl: false });
        return await new Promise<boolean>((resolve) => {
          viewer.addHandler('open', () => {
            // after the home view has loaded, ask for the deepest level too
            setTimeout(() => viewer.viewport.zoomTo(viewer.viewport.getMaxZoom()), 6000);
            resolve(true);
          });
          viewer.addHandler('open-failed', () => resolve(false));
          setTimeout(() => resolve(false), 60_000);
        });
      }, t.service);
    } catch {
      mounted = false;
    }
  }
  // tiles stream in after the canvas exists; the service may be slow (e-codices ~1-15 s)
  await page.waitForTimeout(mounted ? 20_000 : 1_000);
  await classify();

  const shim = await page.evaluate(() => {
    const osd = (window as any).OpenSeadragon;
    return osd ? { version: osd.version?.versionStr, shim: !!osd.IIIFTileSource.prototype.__imageApi3Shim } : null;
  });
  const forms: Record<string, number> = {};
  const bases: Record<string, number> = {};
  for (const x of tiles) {
    const form = x.size === 'max' ? 'max' : /^\d+,\d+$/.test(x.size) ? 'w,h' : /^\d+,$/.test(x.size) ? 'w,' : x.size;
    const key = `${form} ${x.status}`;
    forms[key] = (forms[key] ?? 0) + 1;
    const base =
      x.base === t.service
        ? 'the requested id'
        : new URL(x.base).pathname === new URL(t.service).pathname
        ? `the same path on ${new URL(x.base).host} (the served id)`
        : x.base;
    bases[base] = (bases[base] ?? 0) + 1;
  }
  console.log(`\n== ${t.label}  [${t.kind}]  ${t.iri ?? t.service}`);
  console.log(`  viewer opened: ${mounted}   window.OpenSeadragon: ${JSON.stringify(shim)}`);
  const infoLines = Object.entries(infos).map(([line, n]) => (n > 1 ? `${line}   (x${n})` : line));
  console.log(`  info.json: ${infoLines.length ? '\n    ' + infoLines.join('\n    ') : 'none'}`);
  console.log(`  OpenSeadragon tile requests: ${tiles.length}  by size form/status: ${JSON.stringify(forms)}`);
  console.log(`  tiles requested under: ${JSON.stringify(bases)}`);
  tiles.slice(0, 3).forEach((x) => console.log(`    ${x.status} ${x.url}`));
  console.log(`  other image requests to the same hosts (RS thumbnails etc.): ${JSON.stringify(others)}`);
  tiles
    .filter((x) => x.status >= 400)
    .slice(0, 3)
    .forEach((x) => console.log(`    FAILED ${x.status} ${x.url}`));
  console.log(`  page errors: ${errors.length ? '\n    ' + errors.join('\n    ') : 'none'}`);
}

for (const t of TARGETS) {
  if (ONLY && !t.label.includes(ONLY)) continue;
  test(t.label, async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    await probe(page, baseURL!, t);
  });
}
