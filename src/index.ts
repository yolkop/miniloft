import { deploy, login } from './cloudflare.ts';
import render from './render.ts';
import bakeShapes from './shapes.ts';
import { assert, exists, log, outDir, pool, processJS, prune, readJSON, remove, sandboxed, sliceLiteral, write, xfetch } from './util.ts';

log('init, checking cloudflare status...');

const { accountId, url: loftUrl } = await login();
log(`miniloft will be served from ${loftUrl}`);

const mapsDict = ['id', 'hash', 'name', 'modes', 'availability', 'numPlayers', 'private', 'both', 'FFA', 'Teams', 'Spatula', 'King', 'filename'];
const challengesDict = ['id', 'loc_ref', 'type', 'subType', 'period', 'goal', 'reward', 'conditional', 'value', 'valueTwo', 'tier', 'loc', 'title', 'desc'];

const models: Record<string, string> = {
    'gun_eggk47.glb': 'gun_eggk47',
    'gun_dozenGauge.glb': 'gun_scrambler',
    'gun_csg1.glb': 'gun_freeRanger',
    'gun_rpegg.glb': 'gun_rpegg',
    'gun_smg.glb': 'gun_whipper',
    'gun_m24.glb': 'gun_crackshot',
    'gun_aug.glb': 'gun_triHard',
    'gun_cluck9mm.glb': 'gun_secondary',
    'egg.glb': 'hats',
    'munitions.glb': 'grenades',
    'melee.glb': 'melees'
};

const maintenanceIndicators = ['let brbTime = ', 'currently undergoing some extended', 'making some much needed'];

const statics: Record<string, string> = {
    '_headers': '/*\n  access-control-allow-origin: *\n',
    'robots.txt': 'User-agent: *\nDisallow: /\n',
    '.assetsignore': '.cache\n*.tmp\n.DS_Store\n'
};

const evalArray = (js: string, start: RegExp, name: string) => {
    const value = sandboxed(`JSON.stringify(${sliceLiteral(js, start, name)})`);
    assert(Array.isArray(value), `${name} is not an array`);
    return value as any[];
};

const assertUnique = (list: any[], key: string, name: string) =>
    assert(new Set(list.map(e => e[key])).size === list.length, `${name} have duplicate ${key}s`);

const isSafeName = (name: unknown) => typeof name === 'string' && name.length > 0 && !/[/\\\0]/.test(name) && !name.startsWith('.');

const translate = (key: string) => {
    const value = lang[key];
    assert(typeof value === 'string', `missing translation ${key}`);
    return value;
};

const minify = (object: Record<string, any>, dict: string[]) => {
    for (const key of Object.keys(object)) {
        if (!dict.includes(key)) continue;

        const newKey = String.fromCharCode(dict.indexOf(key) + 48);
        object[newKey] = object[key];
        delete object[key];

        if (typeof object[newKey] === 'object' && object[newKey] !== null) minify(object[newKey], dict);
        else if (typeof object[newKey] === 'string' && dict.includes(object[newKey])) object[newKey] = String.fromCharCode(dict.indexOf(object[newKey]) + 48);
    }
    return object;
};

const hash = (...parts: (string | ArrayBuffer)[]) => {
    const hasher = new Bun.CryptoHasher('sha256');
    for (const part of parts) hasher.update(part);
    return hasher.digest('hex').slice(0, 16);
};

const index = await (await xfetch('/index.php')).text();
if (maintenanceIndicators.some(i => index.includes(i))) {
    log('site is in maintenance, skipping');
    process.exit(0);
}

log(`writing to ${outDir}`);

for (const [file, content] of Object.entries(statics)) write(file, content);

const [js, lang] = await Promise.all([
    xfetch('/js/shellshock.js').then(r => r.arrayBuffer()).then(processJS),
    xfetch('/language/en.json').then(r => r.json()) as Promise<Record<string, string>>
]);

const downloadModels = async () => {
    const buffers = await Promise.all(Object.entries(models).map(async ([src, name]) => {
        const buffer = await (await xfetch(`/models/full/${src}`)).arrayBuffer();
        write(`models/${name}.glb`, buffer);
        return buffer;
    }));
    log(`models: ${buffers.length} downloaded`);
    return hash(...buffers);
};

const extractItems = async (modelsHash: Promise<string>) => {
    const items = evalArray(js, /\[\{id:1001,/, 'items');
    assert(items.length > 1000, `only ${items.length} items`);
    assert(items.every(i => Number.isInteger(i.id) && Number.isInteger(i.item_type_id)), 'items missing id/item_type_id');
    assertUnique(items, 'id', 'items');

    write('data/items.json', JSON.stringify(items, null, 2));
    log(`items: found ${items.length}`);

    const pruned = prune('items', new Set(['stamps.png', ...items.map(i => `${i.id}.png`)]));
    if (pruned) log(`items: removed ${pruned} stale images`);

    const isStamp = (item: any) => item.item_type_id === 2;
    const modelsSig = await modelsHash;
    const signature = (item: any) => hash(JSON.stringify(item), isStamp(item) ? '' : modelsSig);
    const has = (item: any) => exists(`items/${item.id}.png`);

    const cache = readJSON<Record<string, string>>('.cache/items.json')
        ?? Object.fromEntries(items.filter(has).map(i => [i.id, signature(i)]));

    const missing = items.filter(i => cache[i.id] !== signature(i) || !has(i));
    for (const item of missing) remove(`items/${item.id}.png`);

    const missingStamps = missing.filter(isStamp);
    const missingRenders = missing.filter(i => !isStamp(i));

    log(`items: ${missingStamps.length} stamps to download, ${missingRenders.length} to render`);

    try {
        await pool('items', missingStamps, 25, async item => {
            const webp = await (await xfetch(`/img/stamps/stamp-${item.id}.webp`)).arrayBuffer();
            write(`items/${item.id}.png`, await new Bun.Image(webp).png().bytes());
        });

        if (missingRenders.length) await render(missingRenders);
    } finally {
        write('.cache/items.json', JSON.stringify(Object.fromEntries(items.filter(has).map(i => [i.id, signature(i)]))));
    }
};

const photobooth = async () => {
    const home = await (await xfetch('/js/home.js')).text();

    const raw = home.match(/{map:\{names:\["none",(.*?)\]/)?.[1];
    if (!raw) throw new Error('could not find photobooth backgrounds in home.js');
    const names = raw.split(',').map(e => e.slice(1, -1)).sort();
    assert(names.length && names.every(isSafeName), 'photobooth background names look wrong');

    const backgrounds = Object.fromEntries(names.map(name => [name, translate(`screen_photo_booth_map_${name}`)]));

    prune('photobooth/backgrounds', new Set(names.map(n => `${n}.webp`)));

    await pool('photobooth', names, 10, async name => {
        write(`photobooth/backgrounds/${name}.webp`, await (await xfetch(`/img/photo-booth/maps/${name}.webp`)).arrayBuffer());
    });

    write('photobooth/backgrounds.json', JSON.stringify(backgrounds, null, 2));
    log(`photobooth: ${names.length} backgrounds`);
};

const stamps = async () => {
    write('items/stamps.png', await (await xfetch('/img/stamps.png')).arrayBuffer());
    log('stamps: downloaded');
};

const yolkbot = async () => {
    const manifest: Record<string, string> = {};
    const publish = (rel: string, name: string, content: string) => {
        write(rel, content);
        manifest[name] = `${hash(content)}|${loftUrl}/${rel}`;
    };

    const mapEdit = await (await xfetch('/js/mapEdit.js')).text();
    const start = mapEdit.indexOf('var CloseCode = {');
    const end = mapEdit.indexOf('var CommCodeToKey', start);
    if (start < 0 || end < 0) throw new Error('could not find CloseCode/CommCode in mapEdit.js');

    const codes = sandboxed(`${mapEdit.slice(start, end)}\nJSON.stringify({ CloseCode, CommCode });`) as Record<string, Record<string, number>>;
    for (const [name, code] of Object.entries(codes)) {
        assert(code && Object.keys(code).length && Object.values(code).every(Number.isInteger), `${name} looks wrong`);
        publish(`comm/${name}.json`, name, JSON.stringify(Object.fromEntries(Object.entries(code).map(([k, v]) => [k.replaceAll('_', ''), v])), null, 4));
    }

    const maps = evalArray(js, /\[\{filename:/, 'maps');
    assert(maps.length > 10, `only ${maps.length} maps`);
    assert(maps.every(m => isSafeName(m.filename)),'maps have bad filenames');
    assertUnique(maps, 'filename', 'maps');
    publish('min/maps.json', 'maps', JSON.stringify([mapsDict, 48, maps.map(m => minify(structuredClone(m), mapsDict))]));

    const rawChallenges = evalArray(js, /\[\{id:1,/, 'challenges');
    assert(rawChallenges.length > 10, `only ${rawChallenges.length} challenges`);
    assert(rawChallenges.every(c => Number.isInteger(c.id) && typeof c.loc_ref === 'string'), 'challenges missing id/loc_ref');
    assertUnique(rawChallenges, 'id', 'challenges');

    const challenges = rawChallenges.map(c => {
        c.loc = { title: translate(c.loc_ref + '_title'), desc: translate(c.loc_ref + '_desc') };
        minify(c, challengesDict);
        for (const key of Object.keys(c)) if (c[key] === null) delete c[key];
        return c;
    });
    publish('min/challenges.json', 'challenges', JSON.stringify([challengesDict, 48, challenges]));

    publish('min/shapes.json', 'shapes', JSON.stringify(bakeShapes(await (await xfetch('/models/map.glb')).arrayBuffer())));

    const pruned = prune('maps', new Set(maps.map(m => `${m.filename}.json`)));
    if (pruned) log(`yolkbot: removed ${pruned} stale maps`);

    await pool('yolkbot', maps, 10, async m => {
        write(`maps/${m.filename}.json`, await (await xfetch(`/maps/${m.filename}.json?${m.hash}`)).arrayBuffer());
    });

    write('manifestV2.json', JSON.stringify(Object.fromEntries(Object.entries(manifest).sort())));
    log(`yolkbot: manifest written, ${maps.length} maps`);
};

const modelsTask = downloadModels();
const results = await Promise.allSettled([modelsTask, extractItems(modelsTask), photobooth(), stamps(), yolkbot()]);
const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
failed.forEach(f => console.error('[loft] failed:', f.reason));

if (failed.length) {
    log(`build had ${failed.length} failure(s), not deploying`);
    process.exit(1);
}

log('build done, deploying...');
if (!await deploy(accountId, outDir)) {
    console.error('[loft] deploy failed');
    process.exit(1);
}

console.log('');

log(`miniloft deployed!`);
console.log(`\n\n   YOUR URL: \x1b[1;31m${loftUrl}\x1b[0m\n\n`);
process.exit(0);
