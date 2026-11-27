type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Mat4 = number[];
type Shape = [Vec3, Vec3, Quat?];

interface GLTFNode {
    name?: string;
    mesh?: number;
    children?: number[];
    translation?: Vec3;
    rotation?: Quat;
    scale?: Vec3;
}

interface GLTF {
    nodes: GLTFNode[];
    meshes: { primitives: { attributes: Record<string, number> }[] }[];
    accessors: { bufferView: number; byteOffset?: number; count: number }[];
    bufferViews: { byteOffset?: number; byteStride?: number }[];
}

const BAKED = new Set(['aabb', 'obb', 'ladder']);
const NO_ROTATION: Quat = [0, 0, 0, 1];

const matFromQuat = ([x, y, z, w]: Quat): Mat4 => [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (z * x - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (z * z + x * x), 2 * (y * z + x * w), 0,
    2 * (z * x + y * w), 2 * (y * z - x * w), 1 - 2 * (y * y + x * x), 0,
    0, 0, 0, 1
];

const compose = (scale: Vec3, rotation: Quat, translation: Vec3): Mat4 => {
    const rot = matFromQuat(rotation);
    const out = new Array(16).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 4 + c] = rot[r * 4 + c] * scale[r];
    out[12] = translation[0];
    out[13] = translation[1];
    out[14] = translation[2];
    out[15] = 1;
    return out;
};

const matMul = (a: Mat4, b: Mat4): Mat4 => {
    const out = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
    return out;
};

const applyMat = (x: number, y: number, z: number, m: Mat4): Vec3 => [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14]
];

const round = (v: number) => Number(v.toFixed(5));

const parseGLB = (buffer: ArrayBuffer) => {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546C67) throw new Error('not a glb file');

    let gltf: GLTF | null = null;
    let bin: DataView | null = null;

    for (let offset = 12; offset < view.getUint32(8, true);) {
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        if (type === 0x4E4F534A) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length)));
        if (type === 0x004E4942) bin = new DataView(buffer, offset + 8, length);
        offset += 8 + length;
    }

    if (!gltf || !bin) throw new Error('glb is missing its JSON or BIN chunk');
    return { gltf, bin };
};

export default (glb: ArrayBuffer) => {
    const { gltf, bin } = parseGLB(glb);

    const parentOf = new Map<number, number>();
    gltf.nodes.forEach((node, idx) => node.children?.forEach(child => parentOf.set(child, idx)));

    const readPositions = (meshIdx: number) => {
        const accessorIdx = gltf.meshes[meshIdx]?.primitives?.[0]?.attributes?.POSITION;
        if (accessorIdx === undefined) return null;

        const accessor = gltf.accessors[accessorIdx];
        const view = gltf.bufferViews[accessor.bufferView];
        const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const stride = view.byteStride ?? 12;

        const positions = new Float32Array(accessor.count * 3);
        for (let i = 0; i < accessor.count; i++) for (let a = 0; a < 3; a++) positions[i * 3 + a] = bin.getFloat32(base + i * stride + a * 4, true);
        return positions;
    };

    const localMatrix = (node: GLTFNode, withRotation: boolean) =>
        compose(node.scale ?? [1, 1, 1], withRotation ? (node.rotation ?? NO_ROTATION) : NO_ROTATION, node.translation ?? [0, 0, 0]);

    const worldCache = new Map<number, Mat4>();
    const worldMatrix = (idx: number): Mat4 => {
        const cached = worldCache.get(idx);
        if (cached) return cached;
        const parent = parentOf.get(idx);
        const world = parent === undefined ? localMatrix(gltf.nodes[idx], true) : matMul(localMatrix(gltf.nodes[idx], true), worldMatrix(parent));
        worldCache.set(idx, world);
        return world;
    };

    const descendants = (idx: number): number[] => (gltf.nodes[idx].children ?? []).flatMap(child => [child, ...descendants(child)]);

    const shapes: Record<string, Shape[]> = {};

    for (let idx = 0; idx < gltf.nodes.length; idx++) {
        if (parentOf.has(idx)) continue;

        const node = gltf.nodes[idx];
        const colliderType = (node.name ?? '').split('.')[2];
        if (!colliderType || !BAKED.has(colliderType)) continue;

        const proxy = node.children?.[0];
        if (proxy === undefined) continue;

        const built: Shape[] = [];

        for (const partIdx of [proxy, ...descendants(proxy)]) {
            const part = gltf.nodes[partIdx];
            if (part.mesh === undefined) continue;

            const positions = readPositions(part.mesh);
            if (!positions?.length) continue;

            const parent = parentOf.get(partIdx);
            const bounds = parent === undefined ? localMatrix(part, false) : matMul(localMatrix(part, false), worldMatrix(parent));

            const min: Vec3 = [Infinity, Infinity, Infinity];
            const max: Vec3 = [-Infinity, -Infinity, -Infinity];

            for (let i = 0; i < positions.length; i += 3) {
                const point = applyMat(positions[i], positions[i + 1], positions[i + 2], bounds);
                for (let a = 0; a < 3; a++) {
                    if (point[a] < min[a]) min[a] = point[a];
                    if (point[a] > max[a]) max[a] = point[a];
                }
            }

            const shape: Shape = [min.map(round) as Vec3, max.map(round) as Vec3];
            if (part.rotation) shape[2] = part.rotation.map(round) as Quat;
            built.push(shape);
        }

        if (built.length) shapes[node.name!] = built;
    }

    return shapes;
};
