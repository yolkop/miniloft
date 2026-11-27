import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from './util.ts';

const wrangler = async (args: string[]) => {
    const proc = Bun.spawn(['bunx', 'wrangler', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, ok: code === 0 };
};

const fail = (...lines: string[]): never => {
    lines.forEach(line => console.error(`[loft] ${line}`));
    process.exit(1);
};

const ask = (question: string, hint: string) => {
    if (!process.stdin.isTTY) fail(`can't ask "${question}" without a terminal`, hint);
    const answer = prompt(`[loft] ${question}`);
    if (answer === null) fail('no input received', hint);
    return answer!.trim();
};

const whoami = async () => {
    const res = await wrangler(['whoami', '--json']);
    if (!res.ok) return null;
    try {
        const data = JSON.parse(res.out);
        return data.loggedIn ? data.accounts as { id: string; name: string }[] : null;
    } catch {
        return null;
    }
};

const getToken = async () => {
    const res = await wrangler(['auth', 'token', '--json']);
    try {
        const token = res.ok && JSON.parse(res.out).token;
        if (typeof token === 'string' && token) return token;
    } catch { }
    return fail(`couldn't get a Cloudflare API token from wrangler: ${res.err.trim() || res.out.trim() || 'unknown error'}`);
};

export const login = async () => {
    let accounts = await whoami();

    if (!accounts) {
        if (!process.stdin.isTTY) fail('not logged into Cloudflare, run "bunx wrangler login" (or set CLOUDFLARE_API_TOKEN) and try again');
        console.log('[loft] you must be logged into Cloudflare (via wrangler) to run miniloft. opening login...');
        await Bun.spawn(['bunx', 'wrangler', 'login'], { stdio: ['inherit', 'inherit', 'inherit'] }).exited;
        accounts = await whoami();
        if (!accounts) fail('still not logged into Cloudflare, run "bunx wrangler login" and try again');
    }

    if (!accounts!.length) fail('your Cloudflare login has no accounts');

    if (Bun.env.CLOUDFLARE_ACCOUNT_ID && !accounts!.some(a => a.id === Bun.env.CLOUDFLARE_ACCOUNT_ID))
        fail(`CLOUDFLARE_ACCOUNT_ID ${Bun.env.CLOUDFLARE_ACCOUNT_ID} isn't one of your accounts`);

    let account = accounts!.find(a => a.id === Bun.env.CLOUDFLARE_ACCOUNT_ID) ?? (accounts!.length === 1 ? accounts![0] : undefined);

    while (!account) {
        accounts!.forEach((a, i) => console.log(`  ${i + 1}) ${a.name} (${a.id})`));
        account = accounts![Number(ask('which Cloudflare account should miniloft deploy to?', 'set CLOUDFLARE_ACCOUNT_ID to pick an account')) - 1];
    }

    log(`using Cloudflare account ${account.name}`);

    const token = await getToken();
    const headers = { authorization: `Bearer ${token}` };

    const preflightUrl = `https://api.cloudflare.com/client/v4/accounts/${account.id}/workers/scripts/miniloft-preflight`;
    const form = new FormData();
    form.append('metadata', JSON.stringify({ main_module: 'index.js', compatibility_date: new Date().toISOString().slice(0, 10) }));
    form.append('index.js', new Blob(['export default { fetch: () => new Response(null, { status: 204 }) };'], { type: 'application/javascript+module' }), 'index.js');

    const preflight = await fetch(preflightUrl, { method: 'PUT', headers, body: form, signal: AbortSignal.timeout(30_000) })
        .then(r => r.json())
        .catch((e: Error) => ({ success: false, errors: [{ code: 0, message: e.message }] })) as { success: boolean; errors?: { code: number; message: string }[] };

    if (!preflight.success) {
        const message = preflight.errors?.map(e => `${e.message} (${e.code})`).join(', ') || 'unknown error';
        if (/verif|email/i.test(message)) fail(`Cloudflare won't let this account deploy Workers: ${message}`, 'verify your email address in the Cloudflare dashboard, then rerun');
        fail(`Cloudflare won't let this account deploy Workers: ${message}`);
    }

    let deleted = false;
    for (let attempt = 0; attempt < 3 && !deleted; attempt++) {
        if (attempt) await Bun.sleep(2000 * attempt);
        deleted = await fetch(preflightUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) }).then(r => r.ok || r.status === 404).catch(() => false);
    }
    if (!deleted) log('warning: couldn\'t delete the "miniloft-preflight" worker, remove it from the Cloudflare dashboard');

    if (Bun.env.LOFT_URL) return { accountId: account.id, url: Bun.env.LOFT_URL.replace(/\/+$/, '') };

    const subdomainApi = (method: string, body?: object) => fetch(`https://api.cloudflare.com/client/v4/accounts/${account.id}/workers/subdomain`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
    }).then(r => r.json()) as Promise<{ success: boolean; result?: { subdomain: string }; errors?: { message: string }[] }>;

    let subdomain = (await subdomainApi('GET')).result?.subdomain;

    while (!subdomain) {
        log('this Cloudflare account has no workers.dev subdomain yet, so one needs to be created');
        log('it will be permanent for this account and your URL will be https://miniloft.<subdomain>.workers.dev');
        const wanted = ask('subdomain (lowercase letters, numbers, hyphens):', 'create a workers.dev subdomain in the Cloudflare dashboard, or set LOFT_URL').toLowerCase();

        if (!wanted) continue;
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(wanted)) {
            log('invalid subdomain, try again');
            continue;
        }

        const res = await subdomainApi('PUT', { subdomain: wanted });
        if (res.success) subdomain = res.result?.subdomain ?? wanted;
        else log(`couldn't register "${wanted}": ${res.errors?.map(e => e.message).join(', ') || 'unknown error'}`);
    }

    return { accountId: account.id, url: `https://miniloft.${subdomain}.workers.dev` };
};

export const deploy = async (accountId: string, dir: string) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miniloft-'));
    const config = path.join(tmp, 'wrangler.json');

    try {
        fs.writeFileSync(config, JSON.stringify({
            name: 'miniloft',
            compatibility_date: new Date().toISOString().slice(0, 10),
            assets: { directory: dir },
            workers_dev: true,
            preview_urls: true
        }, null, 4));

        const proc = Bun.spawn(['bunx', 'wrangler', 'deploy', `--config=${config}`], {
            stdio: ['inherit', 'inherit', 'inherit'],
            env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId }
        });
        return (await proc.exited) === 0;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
};
