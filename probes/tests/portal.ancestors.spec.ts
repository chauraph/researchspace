import { test } from '@playwright/test';

test('probe: ancestor width chain', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto('/resource/Portal', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mp-card', { timeout: 90_000 });
  await page.waitForTimeout(5000);

  const chain = await page.evaluate(() => {
    const out: any[] = [];
    let el: Element | null = document.querySelector('.mp-portal');
    while (el) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        id: (el as HTMLElement).id || '',
        cls: el.className?.toString().slice(0, 55) || '',
        w: Math.round(r.width),
        cssW: cs.width,
        display: cs.display,
        overflowX: cs.overflowX,
        minW: cs.minWidth,
        maxW: cs.maxWidth,
        flex: cs.flex,
        pos: cs.position,
      });
      el = el.parentElement;
    }
    return { viewport: window.innerWidth, docScrollW: document.documentElement.scrollWidth, chain: out.reverse() };
  });

  console.log('\n════ ANCESTOR CHAIN (html → .mp-portal) ════');
  console.log('viewport:', chain.viewport, ' document scrollWidth:', chain.docScrollW, '\n');
  for (const n of chain.chain) {
    console.log(`  ${n.tag}${n.id ? '#' + n.id : ''}.${n.cls}`.padEnd(58),
      `w=${String(n.w).padStart(5)}  css=${n.cssW.padEnd(10)} ${n.display.padEnd(12)} ovfX=${n.overflowX.padEnd(8)} minW=${n.minW} flex=${n.flex}`);
  }
});
