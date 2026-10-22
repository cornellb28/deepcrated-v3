import { toast } from 'sonner'

// The one way the renderer opens a DeepCrated website page. It names the
// page; main owns the URL (src/main/websiteLinks.ts). A browser that fails
// to open gets a short toast and nothing else blocks.
export async function openWebsite(name: 'account' | 'plans' | 'privacy'): Promise<void> {
  const result = await window.api.openWebsite(name)
  if (!result.ok) toast.error('Could not open your browser', { description: result.error })
}

// Every "See plans" and upgrade prompt goes through here, so there is one
// path to plans.
export function openPlans(): void {
  void openWebsite('plans')
}
