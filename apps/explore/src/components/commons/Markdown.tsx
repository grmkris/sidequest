import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]
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
  pre: ({ children }) => (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Overflowing code must be scrollable with a keyboard in Safari as well as Chromium.
    <pre tabIndex={0} aria-label="Code block">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- This named overflow region needs keyboard focus for horizontal scrolling.
    <section className="commons-table" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </section>
  ),
}

/** Safe GFM for public posts. Raw HTML remains text; react-markdown filters unsafe URL schemes. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="commons-markdown">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
