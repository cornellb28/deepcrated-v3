import React, { useEffect, useState } from 'react'

type Notice = Awaited<ReturnType<Window['api']['licenses']>>[number]

// Settings > About: the licence texts for software shipped with DeepCrated,
// read from resources/licenses/ by main. Plain text, collapsed by default.
export function OpenSourceNotices(): React.JSX.Element {
  const [notices, setNotices] = useState<Notice[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api
      .licenses()
      .then((n) => {
        if (!cancelled) setNotices(n)
      })
      .catch(() => {
        if (!cancelled) setNotices([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (notices === null) return <div style={{ fontSize: '12px', color: '#555' }}>Loading…</div>
  if (notices.length === 0) {
    return <div style={{ fontSize: '12px', color: '#555' }}>No notices found.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {notices.map((notice) => (
        <div key={notice.id}>
          <div style={{ fontSize: '12px', color: '#c0c0d8', marginBottom: '4px' }}>
            {notice.title}
          </div>
          {notice.files.map((file) => (
            <details key={file.name} style={{ marginLeft: '8px' }}>
              <summary style={{ fontSize: '11px', color: '#888', cursor: 'pointer' }}>
                {file.name}
              </summary>
              <pre
                data-selectable
                style={{
                  fontSize: '10px',
                  lineHeight: 1.5,
                  color: '#888',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '240px',
                  overflow: 'auto',
                  margin: '6px 0',
                  padding: '8px',
                  background: '#13131b',
                  borderRadius: '6px'
                }}
              >
                {file.text}
              </pre>
            </details>
          ))}
        </div>
      ))}
    </div>
  )
}
