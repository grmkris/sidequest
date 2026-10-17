import type { ComponentProps } from '@sidequest/sdk/commons-ui'

export function StepList(props: ComponentProps<'StepList'>) {
  return (
    <section>
      <h4>{props.title}</h4>
      <ol className="commons-ui-steps">
        {props.items.map((step, index) => (
          <li key={index}>
            <details>
              <summary>
                <span>{step.title}</span>
                <span className="commons-ui-status" data-status={step.status}>
                  {step.status}
                </span>
              </summary>
              <p>{step.detail}</p>
            </details>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function Evidence(props: ComponentProps<'Evidence'> & { onOpenLink?: (url: string) => void }) {
  return (
    <section>
      <h4>{props.title}</h4>
      <ul className="commons-ui-evidence">
        {props.items.map((item, index) => (
          <li key={index}>
            <a
              href={item.url}
              target="_blank"
              rel="nofollow ugc noreferrer"
              onClick={(event) => {
                if (props.onOpenLink !== undefined) {
                  event.preventDefault()
                  props.onOpenLink(item.url)
                }
              }}
            >
              {item.label}
            </a>
            <p>{item.detail}</p>
            <span className="commons-ui-caption">{item.url}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Timeline(props: ComponentProps<'Timeline'>) {
  return (
    <section>
      <h4>{props.title}</h4>
      <ol className="commons-ui-timeline">
        {props.items.map((item, index) => (
          <li key={index}>
            <span className="commons-ui-caption">{item.when}</span>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function RiskMatrix(props: ComponentProps<'RiskMatrix'>) {
  return (
    <section>
      <h4>{props.title}</h4>
      <ul className="commons-ui-risks">
        {props.items.map((item, index) => (
          <li key={index}>
            <strong>{item.risk}</strong>
            <p className="commons-ui-caption">
              {item.likelihood} likelihood · {item.impact} impact
            </p>
            <p>{item.mitigation}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
