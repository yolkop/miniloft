import puppeteer from 'puppeteer-core';

import { exists, log, write } from './util.ts';

const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(Bun.env.LOCALAPPDATA ? [
        `${Bun.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${Bun.env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`
    ] : []),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const ITEM_TIMEOUT = 30_000;

export default async (all: any[]) => {
    const executablePath = Bun.env.CHROMIUM_PATH || chromePaths.find(p => Bun.file(p).size > 0);
    if (!executablePath) throw new Error('no chromium found, set CHROMIUM_PATH');

    const skipped = new Set<number>();
    const listIds = (ids: number[]) => `${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', ...' : ''}`;

    let stalls = 0;
    let remaining = Infinity;

    while (true) {
        const items = all.filter(i => !skipped.has(i.id) && !exists(`items/${i.id}.png`));
        if (!items.length) break;

        stalls = items.length < remaining ? 0 : stalls + 1;
        remaining = items.length;
        if (stalls >= 3) throw new Error(`render: gave up with ${items.length} items unrendered (${listIds(items.map(i => i.id))})`);

        try {
            const { failed, stuck } = await attempt(executablePath, items);
            failed.forEach(id => skipped.add(id));
            if (stuck !== null) {
                skipped.add(stuck);
                log(`items: ${stuck} timed out, relaunching for a clean canvas...`);
            }
        } catch (e: any) {
            log(`items: browser died (${e.message || e.name}), relaunching...`);
        }
    }

    if (skipped.size) throw new Error(`render: ${skipped.size} items failed or timed out (${listIds([...skipped])})`);
};

const attempt = async (executablePath: string, items: any[]) => {
    const asRoot = process.getuid?.() === 0;
    const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        protocolTimeout: items.length * (ITEM_TIMEOUT + 5_000) + 300_000,
        args: asRoot || Bun.env.LOFT_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url();
            if (url.match(/\/models\/(?!full\/)/)) req.continue({ url: url.replace('/models/', '/models/full/') });
            else req.continue();
        });

        let done = 0;

        await page.exposeFunction('saveRender', (id: number, dataUrl: string) => {
            write(`items/${id}.png`, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
            done++;
            if (done % 50 === 0) log(`items: ${done}/${items.length}`);
        });

        await page.exposeFunction('warnToNode', (...args: any[]) => console.warn('[loft] items:', ...args));

        const ready = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('renderer load timeout')), 120_000);
            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('afterResourcesLoaded') || text.includes('All meshes and ItemRenderer loaded')) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
        ready.catch(() => { });

        log('items: loading game...');
        await page.goto('https://shellshock.io', { waitUntil: 'networkidle2', timeout: 120_000 });
        await ready;
        log('items: renderer loaded, rendering...');

        const result = await page.evaluate(async (items: any[], itemTimeout: number) => {
            const w = window as any;
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            document.body.appendChild(canvas);

            const failed: number[] = [];

            for (const item of items) {
                let settled = false;
                let timer: ReturnType<typeof setTimeout> | undefined;

                const outcome = await new Promise<'done' | 'timeout' | Error>(resolve => {
                    timer = setTimeout(() => !settled && resolve('timeout'), itemTimeout);
                    try {
                        w.extern.renderItemToCanvas(item, canvas, async () => {
                            if (settled) return;
                            settled = true;
                            await w.saveRender(item.id, canvas.toDataURL('image/png'));
                            resolve('done');
                        });
                    } catch (e: any) {
                        resolve(e instanceof Error ? e : new Error(String(e)));
                    }
                });

                settled = true;
                clearTimeout(timer);

                if (outcome === 'timeout') {
                    w.warnToNode('timed out', item.id, item.name, `after ${itemTimeout}ms`);
                    return { failed, stuck: item.id as number };
                }

                if (outcome instanceof Error) {
                    w.warnToNode('failed', item.id, item.name, outcome.message);
                    failed.push(item.id);
                }
            }

            return { failed, stuck: null };
        }, items, ITEM_TIMEOUT);

        log(`items: rendered ${done}/${items.length}`);
        return result;
    } finally {
        await browser.close();
    }
};
