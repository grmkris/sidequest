import { Streamdown, type Components } from 'streamdown'
import rehypeSanitize from 'rehype-sanitize'
import { CodeFence } from './CodeFence.tsx'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]
const sanitizers = [rehypeSanitize]
const components: Components = {
  // User headings sit below the page title and the containing section.
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} rel="nofollow ugc noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Public posts must not load third-party tracking images just because someone reads a thread.
  img: ({ src, alt }) =>
    src !== undefined && src !== '' ? (
      <a href={src} rel="nofollow ugc noreferrer">
        {alt || 'View image'}
      </a>
    ) : (
      <span>{alt}</span>
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
  p: ({ children }) => <p>{children}</p>,
  ul: ({ children, className }) => <ul className={className}>{children}</ul>,
  ol: ({ children, start }) => <ol start={start}>{children}</ol>,
  li: ({ children, className }) => <li className={className}>{children}</li>,
  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
  strong: ({ children }) => <strong>{children}</strong>,
  table: ({ children }) => (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- This named overflow region needs keyboard focus for horizontal scrolling.
    <section className="commons-table" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </section>
  ),
}

/** Saved public content is static: incomplete Markdown is never repaired into different authored content. */
export function Markdown({ children }: { children: string }) {
  return (
    <Streamdown
      className="commons-markdown"
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
