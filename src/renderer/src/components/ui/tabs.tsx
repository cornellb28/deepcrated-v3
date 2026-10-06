import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'

import { cn } from '@renderer/lib/utils'

// Thin wrapper over Radix Tabs, same shape as the other ui/ primitives.
// Radix is already a dependency, and it brings the keyboard behaviour a
// hand-rolled strip would have to reimplement: roving tabindex, arrow-key
// navigation, and the aria-controls/aria-labelledby pairing between each
// tab and its panel.

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>): React.JSX.Element {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  )
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'px-3 py-1.5 text-xs rounded-md transition-colors cursor-pointer',
        'text-[#555] hover:text-[#c0c0d8]',
        'data-[state=active]:bg-[#1a1a26] data-[state=active]:text-[#a09be8]',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#7f77dd]',
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>): React.JSX.Element {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
