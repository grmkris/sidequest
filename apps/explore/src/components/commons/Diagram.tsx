import { useEffect, useState } from 'react'
import { mermaid } from '@streamdown/mermaid'

const policy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"

/** Render in an opaque, scriptless frame: authored SVG cannot contact other origins or navigate the app. */
export default function Diagram({ code }: { code: string }) {
  const [document, setDocument] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    const render = async () => {
      try {
        // Disallow config directives and HTML before Mermaid processes the source in the parent document.
        if (
          code.length > 8000 ||
          !/^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b/u.test(code) ||
          /[^\w\s[\](){}.,:;|=?!>\x22-]/u.test(code) ||
          /\b(?:click|href|image|icon|style|classDef|linkStyle)\b/iu.test(code)
        )
          throw new Error('Unsupported diagram markup')
        const instance = mermaid.getMermaid({
          securityLevel: 'strict',
          startOnLoad: false,
          suppressErrorRendering: true,
          htmlLabels: false,
        })
        const { svg } = await instance.render(`commons-${crypto.randomUUID()}`, code)
        if (current)
          setDocument(
            `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><style>body{margin:0;padding:12px;font-family:system-ui}svg{max-width:100%;height:auto}</style></head><body>${svg}</body></html>`,
          )
      } catch {
        if (current) setFailed(true)
      }
    }
    void render()
    return () => {
      current = false
    }
  }, [code])
  if (failed)
    return (
      <div className="p-3">
        <p>Diagram unavailable. The source is below.</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    )
  if (document === undefined) return <output className="block p-3">Drawing diagram…</output>
  return <iframe title="Plan diagram" sandbox="" srcDoc={document} className="h-80 w-full border-0 bg-white" />
}
