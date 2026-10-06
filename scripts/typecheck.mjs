import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  // npm scripts on Windows do not expand globs. Match the former immediate-package glob
  // explicitly, then run the JS compiler through Node rather than a platform-specific shim.
  const projects = readdirSync(join(root, 'packages')).sort().flatMap(name => {
    const config = join('packages', name, 'tsconfig.json');
    try {
      return statSync(join(root, config)).isFile() ? [config] : [];
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    }
  });
  if (!projects.length) throw new Error('No package tsconfig.json projects found');
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '-b', ...projects], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`TypeScript terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
