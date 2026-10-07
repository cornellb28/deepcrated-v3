import React from 'react'

// The small accessible on/off switch the Privacy settings share.
export function SwitchButton({
  checked,
  disabled,
  labelledBy,
  testId,
  onClick
}: {
  checked: boolean
  disabled?: boolean
  labelledBy: string
  testId?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '30px',
        height: '17px',
        borderRadius: '10px',
        border: 'none',
        padding: 0,
        marginTop: '1px',
        background: checked ? '#7f77dd' : '#252535',
        position: 'relative',
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s'
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '2px',
          left: checked ? '15px' : '2px',
          width: '13px',
          height: '13px',
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.15s'
        }}
      />
    </button>
  )
}
