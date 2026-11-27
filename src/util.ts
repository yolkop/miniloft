import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const outDir = path.resolve(Bun.env.LOFT_OUT || path.join(import.meta.dirname, '..', 'out'));

const fetchWithRetry = async (url: URL, attempts = 4): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch((e: Error) => e);
        if (res instanceof Response && res.ok) return res;

        const retryable = !(res instanceof Response) || res.status === 429 || res.status >= 500;
        const reason = res instanceof Response ? `returned ${res.status}` : `failed: ${res.message}`;
        if (res instanceof Response) await res.body?.cancel();
        if (!retryable || attempt >= attempts) throw new Error(`${url.pathname} ${reason}`);

        await Bun.sleep(1000 * 2 ** (attempt - 1) + Math.random() * 500);
    }
};

export const xfetch = (pathname: string) => {
    const url = new URL(pathname, 'https://shellshock.io');
    url.searchParams.set('cacheBust', Date.now().toString());
    return fetchWithRetry(url);
};

export const pool = async <T>(name: string, items: T[], limit: number, fn: (item: T) => Promise<void>) => {
    let next = 0;
    let failed = 0;

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++];
            try {
                await fn(item);
            } catch (e: any) {
                failed++;
                console.error(`[loft] ${name}: ${e.message}`);
            }
        }
    }));

    if (failed) throw new Error(`${name}: ${failed}/${items.length} failed`);
};

export const write = (rel: string, data: string | ArrayBuffer | Uint8Array) => {
    const file = path.join(outDir, rel);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, typeof data === 'string' ? data : new Uint8Array(data));
    fs.renameSync(tmp, file);
};

export const exists = (rel: string) => fs.existsSync(path.join(outDir, rel));

export const remove = (rel: string) => fs.rmSync(path.join(outDir, rel), { force: true });

export const readJSON = <T>(rel: string): T | null => {
    try {
        return JSON.parse(fs.readFileSync(path.join(outDir, rel), 'utf-8'));
    } catch {
        return null;
    }
};

export const prune = (relDir: string, keep: Set<string>) => {
    const dir = path.join(outDir, relDir);
    if (!fs.existsSync(dir)) return 0;

    const stale = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && !keep.has(e.name));
    for (const entry of stale) fs.rmSync(path.join(dir, entry.name));
    return stale.length;
};

export const processJS = (input: ArrayBuffer) => {
    const bytes = new Uint8Array(input);
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= (88 + i) & 0x7F;
    return new TextDecoder().decode(bytes);
};

export const sandboxed = (script: string) =>
    JSON.parse(vm.runInNewContext(script, Object.create(null), { timeout: 5000 }));

export const sliceLiteral = (src: string, start: RegExp, name: string) => {
    const from = src.search(start);
    if (from < 0) throw new Error(`could not find ${name}`);

    let depth = 0;
    let quote = '';
    for (let i = from; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = '';
        } else if (c === '"' || c === '\'' || c === '`') quote = c;
        else if (c === '[' || c === '{') depth++;
        else if ((c === ']' || c === '}') && --depth === 0) return src.slice(from, i + 1);
    }

    throw new Error(`${name} literal never closes`);
};

export const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`sanity check failed: ${message}`);
};

export const log = (...args: any[]) => console.log('[loft]', ...args);
