import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { OAuthClient } from './OAuthClient.tsx'

test('identical self-declared names cannot hide different client destinations', () => {
  const name = 'My editor <script>alert(1)</script>'
  const first = renderToStaticMarkup(
    <OAuthClient client={{ clientId: 'first', clientName: name, redirectUri: 'http://127.0.0.1:3210/callback' }} />,
  )
  const second = renderToStaticMarkup(
    <OAuthClient
      client={{ clientId: 'second', clientName: name, redirectUri: 'https://untrusted.example/callback' }}
    />,
  )
  expect(first).toContain('Recipient: 127.0.0.1')
  expect(first).toContain('Only approve if you started this connection in an app on this device.')
  expect(second).toContain('Recipient: untrusted.example')
  expect(second).not.toContain('Only approve if')
  expect(first).toContain('(unverified name)')
  expect(second).toContain('(unverified name)')
  expect(first).toContain('http://127.0.0.1:3210/callback')
  expect(second).toContain('https://untrusted.example/callback')
  expect(first).toContain('Client ID: first')
  expect(second).toContain('Client ID: second')
  expect(second).not.toContain('<script>')
})
