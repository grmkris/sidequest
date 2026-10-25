import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  verifiedEffectOutput,
  PLUGIN,
  effectArgs,
  effectProjects,
  missingPlugin,
  pluginBlock,
  typecheckProjects,
} from '../effect.ts'
import { decodeEffect, fromEffect, typescriptErrors, uncheckedFiles } from '../report.ts'
import { repoRoot } from '../run.ts'

const at = { line: 4, column: 2, message: 'm' }

describe('the checker (ADR 0030)', () => {
  test('effect-tsrs runs as its native binary; the typecheck pass is the compiler alone', () => {
    const [binary, ...args] = effectArgs('tools/tsconfig.json', 'none')
    expect(binary).toMatch(/@yielded\/effect-tsrs-[a-z0-9]+-[a-z0-9]+\/bin\/effect-tsrs$/u)
    expect(args).toEqual([
      'diagnostics',
      '-p',
      path.join(repoRoot, 'tools/tsconfig.json'),
      '--type-check',
      '--format',
      'json',
      '--rules',
      'none',
    ])
    expect(effectArgs('tools/tsconfig.json')).not.toContain('--rules')
  })
})

describe('the projects', () => {
  test('come from the typecheck scripts, and every one has the Effect plugin block', () => {
    expect(
      typecheckProjects('bun tools/typecheck.ts --workspaces scripts/ci/tsconfig.json crew/tsconfig.json'),
    ).toEqual(['scripts/ci/tsconfig.json', 'crew/tsconfig.json'])
    expect(typecheckProjects('tsc -p tsconfig.json')).toEqual([])
    const projects = effectProjects()
    expect(projects).toContainEqual({ dir: '.', tsconfig: 'crew/tsconfig.json' })
    expect(projects).toContainEqual({ dir: 'apps/api', tsconfig: 'tsconfig.json' })
    for (const { dir, tsconfig } of projects) expect(missingPlugin(path.join(dir, tsconfig))).toBeUndefined()
  })
})

describe('the plugin block through extends', () => {
  const owned: string[] = []
  afterEach(() => {
    for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const configs = (files: Readonly<Record<string, unknown>>): ((name: string) => string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sidequest-plugin-block-'))
    owned.push(dir)
    for (const [name, config] of Object.entries(files)) writeFileSync(path.join(dir, name), JSON.stringify(config))
    return (name) => path.join(dir, name)
  }

  test('is inherited, and a later or own plugins list replaces it; a package tsconfig is not followed', () => {
    const config = configs({
      'base.json': { compilerOptions: { plugins: [{ name: PLUGIN }] } },
      'child.json': { extends: './base' },
      'off.json': { extends: './base.json', compilerOptions: { plugins: [] } },
      'later.json': { extends: ['./base.json', './off.json'] },
      'pkg.json': { extends: '@tsconfig/strictest' },
    })
    expect(pluginBlock(config('child.json'))).toEqual({ name: PLUGIN })
    expect(missingPlugin(config('off.json'))).toContain('does not enable @effect/language-service')
    expect(pluginBlock(config('later.json'))).toBeUndefined()
    expect(() => pluginBlock(config('pkg.json'))).toThrow('cannot follow extends')
  })
})

describe('effect-tsrs output', () => {
  test('errors, warnings and unused directives count, as effect(<name>), with repository-relative paths', () => {
    const file = `${repoRoot}/apps/api/src/a.ts`
    const output = decodeEffect({
      diagnostics: [
        { ...at, file, severity: 'error', code: 377001, name: 'processEnv' },
        { ...at, file, severity: 'message', code: 377003, name: 'schemaNumber' },
        { ...at, line: 9, file, severity: 'warning', code: 377000, name: 'unusedDirective' },
      ],
      typescriptDiagnostics: [],
      summary: { filesChecked: 1, errors: 1, warnings: 1, messages: 1 },
    })
    expect(fromEffect(output).map((finding) => [finding.rule, finding.file, finding.line])).toEqual([
      ['effect(processEnv)', 'apps/api/src/a.ts', 4],
      ['effect(unusedDirective)', 'apps/api/src/a.ts', 9],
    ])
  })

  test('TypeScript errors print as tsc prints them; files counted without the plugin fail the check', () => {
    const output = decodeEffect({
      diagnostics: [],
      typescriptDiagnostics: [
        {
          code: 2322,
          severity: 'error',
          message: 'm',
          location: { file: `${repoRoot}/tools/a.ts`, line: 1, column: 7 },
        },
        { code: 5023, severity: 'error', message: "Unknown compiler option 'x'." },
      ],
      summary: { filesChecked: 1 },
    })
    expect(typescriptErrors(output)).toEqual([
      'tools/a.ts(1,7): error TS2322: m',
      "error TS5023: Unknown compiler option 'x'.",
    ])
    expect(uncheckedFiles('x', output)).toBeUndefined()
    expect(
      uncheckedFiles('x', decodeEffect({ diagnostics: [], summary: { filesChecked: 3, filesWithoutPlugin: 2 } })),
    ).toContain('2 files went unchecked')
  })

  test('a directive-shaped string is not a directive', () => {
    const source =
      "const fixture = '// @effect-diagnostics-next-line globalDate:off'\n// @effect-diagnostics globalDate:off\n"
    const file = `${repoRoot}/tools/test/fixture.ts`
    const directive = (line: number, column: number) => ({
      file,
      line,
      column,
      code: 377000,
      severity: 'warning',
      name: 'unusedDirective',
      message: 'm',
    })
    const output = decodeEffect({ diagnostics: [directive(1, 22), directive(2, 4)], summary: { filesChecked: 1 } })
    expect(verifiedEffectOutput(output, () => source).diagnostics.map((diagnostic) => diagnostic.line)).toEqual([2])
  })
})
