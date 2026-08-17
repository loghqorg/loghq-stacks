/**
 * Produce `dist/index.js` and `dist/index.d.ts`.
 *
 * Two tools, one command. Bun.build emits the JavaScript, and `tsc` emits the
 * declarations because Bun still has no declaration emitter of its own (there
 * is no `--dts` on `bun build` as of 1.3). Keeping both behind `bun run build`
 * means CI and `prepublishOnly` only ever need to know about the one script,
 * and it avoids pulling in a bundler just to reach parity.
 */
import { rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { $ } from 'bun'

const root = import.meta.dir
const outdir = `${root}/dist`

/**
 * A generated project file rather than command-line flags, because `tsc -p`
 * accepts compiler-option overrides but not an `include` override, and the
 * checked-in tsconfig deliberately covers `test/` and this script. Emitting
 * from that config would push a `src/` subdirectory into `dist/` and move
 * `index.d.ts` out from under the path `package.json` publishes.
 */
const dtsProject = `${root}/tsconfig.dts.json`

const dtsConfig = {
  extends: './tsconfig.json',
  include: ['src'],
  compilerOptions: {
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    // A type error should leave no declarations at all. Emitting them anyway
    // means a failed build still looks publishable on disk.
    noEmitOnError: true,
    rootDir: 'src',
    outDir: 'dist',
  },
}

async function bundle(): Promise<void> {
  const built = await Bun.build({
    entrypoints: [`${root}/src/index.ts`],
    outdir,
    format: 'esm',
    // Node-targeted output runs on Bun, but Bun-targeted output does not always
    // run on Node, and this package supports both.
    target: 'node',
    // Nothing outside `src/` gets inlined. `@stacksjs/*` is a devDependency here
    // so it resolves during a build, and bundling it would turn an optional peer
    // into a silent hard dependency shipped inside dist.
    packages: 'external',
    // Deliberately unminified. This sits in the middle of a host application's
    // logging path, where a readable frame in a stack trace is worth more than
    // the handful of kilobytes minifying would save.
    minify: false,
  })

  if (built.success)
    return

  for (const message of built.logs)
    console.error(message)

  process.exit(1)
}

async function declarations(): Promise<void> {
  await writeFile(dtsProject, `${JSON.stringify(dtsConfig, null, 2)}\n`)

  let exitCode: number
  try {
    // `.nothrow()` so the temp project file is always cleaned up, even on a type
    // error, instead of leaving a stray config behind for the next run to trip on.
    exitCode = (await $`bunx --bun tsc -p ${dtsProject}`.cwd(root).nothrow()).exitCode
  }
  finally {
    await rm(dtsProject, { force: true })
  }

  if (exitCode !== 0)
    process.exit(exitCode)
}

/**
 * Assert the two paths `package.json` points at, so a build that silently
 * stopped emitting one of them fails here rather than at `npm publish`.
 */
async function verify(): Promise<void> {
  for (const artifact of ['index.js', 'index.d.ts']) {
    if (!(await Bun.file(`${outdir}/${artifact}`).exists())) {
      console.error(`build failed: dist/${artifact} was not emitted`)
      process.exit(1)
    }
  }
}

async function main(): Promise<void> {
  await rm(outdir, { recursive: true, force: true })
  await bundle()
  await declarations()
  await verify()

  console.info('built dist/index.js and dist/index.d.ts')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
