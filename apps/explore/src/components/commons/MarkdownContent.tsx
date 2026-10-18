import { Streamdown, type Components } from 'streamdown'
import rehypeSanitize from 'rehype-sanitize'
import { CodeFence } from './CodeFence.tsx'
import remarkGfm from 'remark-gfm'
import type { ReactNode } from 'react'

// remark already prefixes footnote ids; sanitation prefixes them again. Keep one safe prefix so hrefs resolve.
const sanitizedId = (id: string | undefined) => id?.replace(/^user-content-(?=user-content-)/u, '')

function MessageLink({
  href,
  children,
  id,
  className,
}: {
  href: string | undefined
  children: ReactNode
  id?: string | undefined
  className?: string | undefined
}) {
  if (!href) return <span>{children}</span>
  let host: string | undefined
  try {
    const target = new URL(href, globalThis.location?.href)
    if (['http:', 'https:'].includes(target.protocol) && target.origin !== globalThis.location?.origin)
      host = target.hostname
  } catch {
    // Relative URLs remain local during server rendering, where there is no origin.
  }
  return (
    <a
      href={href}
      id={sanitizedId(id)}
      className={className}
      rel="nofollow ugc noopener noreferrer"
      {...(host === undefined ? {} : { target: '_blank' })}
    >
      {children}
      {host === undefined ? null : ` (${host})`}
    </a>
  )
}

const plugins = [remarkGfm]
/** The rendered tree's element and text nodes; other node kinds pass through untouched. */
interface TreeNode {
  type: string
  tagName?: string
  value?: string
  children?: TreeNode[]
}
const BLOCKS = new Set(['p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tr', 'hr'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'details'])
const isBlock = (node: TreeNode | undefined) =>
  node?.type === 'element' && (BLOCKS.has(node.tagName ?? '') || HEADINGS.has(node.tagName ?? ''))
const isSeparator = (node: TreeNode) => node.type === 'text' && /^[ \t]*\n\s*$/u.test(node.value ?? '')
function pruneBlockSeparators(node: TreeNode): void {
  if (node.children === undefined) return
  node.children = node.children.filter(
    (child, index, all) => !(isSeparator(child) && (isBlock(all[index - 1]) || isBlock(all[index + 1]))),
  )
  node.children.forEach(pruneBlockSeparators)
}
/**
 * The container keeps raw text's line breaks (pre-line), so the newline text Markdown leaves between blocks would render
 * as blank lines. Drop only newline-only text beside a block; soft breaks and raw text keep theirs.
 */
const dropBlockSeparators = () => pruneBlockSeparators
const sanitizers = [rehypeSanitize, dropBlockSeparators]
const components: Components = {
  // User headings sit below the page title and the containing section.
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children, className, id }) => (
    <h4 id={sanitizedId(id)} className={className}>
      {children}
    </h4>
  ),
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  a: ({ href, children, className, id }) => (
    <MessageLink href={href} id={sanitizedId(id)} className={className}>
      {children}
    </MessageLink>
  ),
  // Public posts must not load third-party tracking images just because someone reads a thread.
  img: ({ src, alt, className, id }) => (
    <MessageLink href={src} id={sanitizedId(id)} className={className}>
      {alt || 'View image'}
    </MessageLink>
  ),
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked ?? false}
      disabled
      aria-label={checked ? 'Completed task' : 'Incomplete task'}
    />
  ),
  // Read the parsed fence, never HTML. Inline code stays a normal code element.
  pre: ({ node }) => {
    const code = node?.children[0]
    if (code?.type !== 'element') return null
    const classes = code.properties.className
    const language = Array.isArray(classes)
      ? (classes.find((value) => value.startsWith('language-')) ?? '').slice(9)
      : ''
    const source = code.children
      .map((child) => (child.type === 'text' ? child.value : ''))
      .join('')
      .replace(/\n$/u, '')
    return <CodeFence key={`${language}:${source}`} code={source} language={language} />
  },
  code: ({ children }) => <code>{children}</code>,
  p: ({ children, className, id }) => (
    <p id={sanitizedId(id)} className={className}>
      {children}
    </p>
  ),
  ul: ({ children, className, id }) => (
    <ul id={sanitizedId(id)} className={className}>
      {children}
    </ul>
  ),
  ol: ({ children, start, className, id }) => (
    <ol id={sanitizedId(id)} className={className} start={start}>
      {children}
    </ol>
  ),
  li: ({ children, className, id }) => (
    <li id={sanitizedId(id)} className={className}>
      {children}
    </li>
  ),
  blockquote: ({ children, className, id }) => (
    <blockquote id={sanitizedId(id)} className={className}>
      {children}
    </blockquote>
  ),
  div: ({ children, className, id }) => (
    <div id={sanitizedId(id)} className={className}>
      {children}
    </div>
  ),
  strong: ({ children }) => <strong>{children}</strong>,
  table: ({ children }) => (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- This named overflow region needs keyboard focus for horizontal scrolling.
    <section className="commons-table" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </section>
  ),
}

/** Saved public content is static: incomplete Markdown is never repaired into different authored content. */
export default function MarkdownContent({ children }: { children: string }) {
  return (
    <Streamdown
      className="commons-markdown whitespace-pre-line!"
      mode="static"
      parseIncompleteMarkdown={false}
      animated={false}
      remarkPlugins={plugins}
      rehypePlugins={sanitizers}
      components={components}
      controls={false}
    >
      {children}
    </Streamdown>
  )
}
