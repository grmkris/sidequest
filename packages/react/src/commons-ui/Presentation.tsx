import { StepList, Evidence, Timeline, RiskMatrix } from './Blocks.tsx'
import { useId, useMemo, useState } from 'react'
import {
  readPresentation,
  type Presentation as Document,
  type PresentationElement,
  type ComponentProps,
} from '@sidequest/sdk/commons-ui'

export type DraftHandler = (text: string) => void
export type LinkHandler = (url: string) => void

/** Validates again at the display boundary. No tool provider, effects or remote resources are available to authored UI. */
export function CommonsPresentation({
  value,
  onDraft,
  onOpenLink,
}: {
  value: unknown
  onDraft?: DraftHandler
  onOpenLink?: LinkHandler
}) {
  const document = useMemo(() => readPresentation(value), [value])
  if (document === null)
    return <p className="commons-ui-fallback">This interactive attachment is unavailable. Read the message above.</p>
  return (
    <DocumentView
      key={JSON.stringify(document)}
      document={document}
      {...(onDraft === undefined ? {} : { onDraft })}
      {...(onOpenLink === undefined ? {} : { onOpenLink })}
    />
  )
}

function DocumentView({
  document,
  onDraft,
  onOpenLink,
}: {
  document: Document
  onDraft?: DraftHandler
  onOpenLink?: LinkHandler
}) {
  const render = (id: string) => {
    const element = document.spec.elements[id]!
    return (
      <div key={id} className="commons-ui-block">
        <Element
          element={element}
          render={render}
          {...(onDraft === undefined ? {} : { onDraft })}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
        />
      </div>
    )
  }
  return (
    <section className="commons-ui" aria-label="Interactive attachment">
      <p className="commons-ui-caption">Explore this plan. Choices stay on this page until you post a reply.</p>
      {render(document.spec.root)}
    </section>
  )
}

function Element({
  element,
  render,
  onDraft,
  onOpenLink,
}: {
  element: PresentationElement
  render: (id: string) => React.ReactNode
  onDraft?: DraftHandler
  onOpenLink?: LinkHandler
}) {
  switch (element.type) {
    case 'Plan':
      return (
        <section className="commons-ui-plan">
          <h3>{element.props.title}</h3>
          <p>{element.props.summary}</p>
          {element.children.map(render)}
        </section>
      )
    case 'StepList':
      return <StepList {...element.props} />
    case 'Decision':
      return (
        <Choice
          prompt={element.props.title}
          options={element.props.options}
          {...(onDraft === undefined ? {} : { onDraft })}
        />
      )
    case 'AskQuestion':
      return (
        <Choice
          prompt={element.props.question}
          options={element.props.options.map((label) => ({ label }))}
          {...(onDraft === undefined ? {} : { onDraft })}
        />
      )
    case 'Evidence':
      return <Evidence {...element.props} {...(onOpenLink === undefined ? {} : { onOpenLink })} />
    case 'Timeline':
      return <Timeline {...element.props} />
    case 'DataTable':
      return <DataTable {...element.props} />
    case 'Callout':
      return (
        <aside className="commons-ui-callout" data-tone={element.props.tone}>
          <h4>{element.props.title}</h4>
          <p>{element.props.text}</p>
        </aside>
      )
    case 'RiskMatrix':
      return <RiskMatrix {...element.props} />
    case 'DraftReply':
      return (
        <section>
          <h4>Suggested reply</h4>
          <blockquote>{element.props.text}</blockquote>
          {onDraft !== undefined && (
            <button type="button" onClick={() => onDraft(element.props.text)}>
              Use in reply
            </button>
          )}
        </section>
      )
  }
}

function Choice({
  prompt,
  options,
  onDraft,
}: {
  prompt: string
  options: readonly { label: string; detail?: string }[]
  onDraft?: DraftHandler
}) {
  const id = useId()
  const [selected, setSelected] = useState<number>()
  const option = selected === undefined ? undefined : options[selected]
  return (
    <fieldset className="commons-ui-choice">
      <legend>{prompt}</legend>
      <div className="commons-ui-options">
        {options.map((item, index) => (
          <label key={item.label} className="commons-ui-option" data-selected={selected === index}>
            <input type="radio" name={id} checked={selected === index} onChange={() => setSelected(index)} />
            <span>
              <strong>{item.label}</strong>
              {item.detail !== undefined && <span>{item.detail}</span>}
            </span>
          </label>
        ))}
      </div>
      {onDraft !== undefined && (
        <button
          type="button"
          disabled={option === undefined}
          onClick={() => {
            if (option !== undefined)
              onDraft([prompt, option.label, option.detail].filter((part) => part !== undefined).join('\n\n'))
          }}
        >
          Use selection in reply
        </button>
      )}
    </fieldset>
  )
}

function DataTable({ title, columns, rows }: ComponentProps<'DataTable'>) {
  const id = useId()
  const [query, setQuery] = useState('')
  const shown = rows.filter((row) => row.some((cell) => cell.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  return (
    <section>
      <h4>{title}</h4>
      <label className="commons-ui-filter" htmlFor={id}>
        Filter rows
        <input id={id} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <output className="commons-ui-caption">
        {shown.length} of {rows.length} rows
      </output>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Named overflow region provides keyboard scrolling in Safari. */}
      <section aria-label={`${title} table`} tabIndex={0} className="commons-ui-table">
        <table>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={index} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {shown.length === 0 && <p>No rows match. Change the filter to see more.</p>}
    </section>
  )
}
