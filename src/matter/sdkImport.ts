import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve from the host SDK, keeping the same Matter singleton instances.
export function resolveMatterEsm(packageName: string, internalPath?: string): string {
    let anchor = import.meta.url;
    try { anchor = import.meta.resolve('matterbridge/matter'); } catch { /* standalone */ }
    const resolver = createRequire(anchor);
    for (const directory of resolver.resolve.paths(packageName) ?? []) {
        const root = join(directory, packageName);
        const manifest = join(root, 'package.json');
        if (!existsSync(manifest)) continue;
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        const entry = pkg.exports?.['.']?.import;
        const target = internalPath ?? (typeof entry === 'string' ? entry : entry?.default) ?? pkg.module;
        if (typeof target !== 'string') throw new Error(`No ESM entry for ${packageName}`);
        const file = join(root, target);
        if (!existsSync(file)) throw new Error(`Missing Matter ESM module: ${file}`);
        return pathToFileURL(file).href;
    }
    throw new Error(`Cannot locate ${packageName} from the Matterbridge SDK`);
}
