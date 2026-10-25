/**
 * The `sidequest` oxlint plugin: repository invariants from AGENTS.md that a generic linter cannot know.
 *
 * - `require-disable-description`: every disabled rule says why (`-- reason`).
 */
import { definePlugin, defineRule } from '@oxlint/plugins'
import type { Context, ESTree } from '@oxlint/plugins'
import { isStringLiteral } from './scope.ts'

/** User-facing copy uses a comma, colon, parentheses or a new sentence instead of an em dash. */
export const noEmDashCopy = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Keep shipped user-facing copy free of U+2014 em dashes.' },
    messages: {
      emDash:
        'Use a comma, colon, parentheses or a new sentence instead of an em dash in user-facing copy. Use EMPTY_CELL only for an empty cell.',
    },
    schema: [],
  },
  create(context: Context) {
    const filename = context.filename.replaceAll('\\', '/')
    if (/(?:^|\/)(?:test|tests)\//u.test(filename) || /\.test\.[cm]?[jt]sx?$/u.test(filename)) return {}
    const check = (node: ESTree.Node, value: string): void => {
      const copy =
        node.type === 'JSXText' || node.parent?.type === 'JSXAttribute'
          ? value.replaceAll(/&(?:mdash|#0*8212|#x0*2014);/giu, '\u2014')
          : value
      if (!copy.includes('\u2014')) return
      const parent = node.parent
      if (
        value === '\u2014' &&
        filename.endsWith('/apps/explore/src/format.ts') &&
        parent?.type === 'VariableDeclarator' &&
        parent.id.type === 'Identifier' &&
        parent.id.name === 'EMPTY_CELL' &&
        parent.parent.type === 'VariableDeclaration' &&
        parent.parent.kind === 'const'
      )
        return
      context.report({ node, messageId: 'emDash' })
    }
    return {
      Literal(node: ESTree.Node) {
        if (isStringLiteral(node)) check(node, node.value)
      },
      TemplateElement(node: ESTree.TemplateElement) {
        check(node, node.value.cooked ?? node.value.raw)
      },
      JSXText(node: ESTree.JSXText) {
        check(node, node.value)
      },
    }
  },
})

const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s|$)/
/** `@effect-diagnostics[-next-line] <name>:off` (effect:check); one that raises a severity needs no reason. */
const EFFECT_OFF = /^\s*@effect-diagnostics(?:-next-line)?\s[^-]*:off\b/
const MIN_REASON = 10

export const requireDisableDescription = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disable directives say why: `-- reason`.' },
    messages: {
      reason:
        'This disable directive has no reason. Write `{{directive}} {{target}} -- <why the rule is wrong here>` (at least 10 characters), or fix the code instead (docs/agents/lint-quality.md).',
    },
    schema: [],
  },
  create(context: Context) {
    return {
      Program: (): void => {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value
          if (!DIRECTIVE.test(text) && !EFFECT_OFF.test(text)) continue
          const separator = text.indexOf('--')
          const reason = separator === -1 ? '' : text.slice(separator + 2).trim()
          if (reason.length >= MIN_REASON) continue
          const directive = text.trim().split(/\s/)[0] ?? 'oxlint-disable'
          const target = directive.startsWith('@effect') ? '<diagnostic>:off' : '<rule>'
          context.report({ messageId: 'reason', data: { directive, target }, loc: comment.loc })
        }
      },
    }
  },
})

export default definePlugin({
  meta: { name: 'sidequest' },
  rules: { 'require-disable-description': requireDisableDescription, 'no-em-dash-copy': noEmDashCopy },
})
