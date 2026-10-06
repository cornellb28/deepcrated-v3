import React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

// Matches the app's existing dark palette (see MoveConfirmDialog, MoveToModal)
// rather than shadcn's CSS-variable convention, since the rest of the UI is
// styled with inline hex values, not theme tokens.
export function Toaster(props: ToasterProps): React.JSX.Element {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      toastOptions={{
        style: {
          background: '#1a1a26',
          border: '0.5px solid #252535',
          color: '#e8e8f0',
          fontSize: '13px',
          borderRadius: '8px'
        },
        classNames: {
          success: 'toast-success',
          error: 'toast-error'
        }
      }}
      style={
        {
          '--success-bg': '#1a1a26',
          '--success-border': '#1d9e75',
          '--success-text': '#e8e8f0',
          '--error-bg': '#1a1a26',
          '--error-border': '#d4537e',
          '--error-text': '#e8e8f0'
        } as React.CSSProperties
      }
      {...props}
    />
  )
}
