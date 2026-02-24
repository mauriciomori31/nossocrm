/**
 * @fileoverview Selector hooks for CRMContext
 *
 * These hooks wrap `useCRM()` and expose only the fields required by a
 * specific domain, reducing the surface area of a component's subscription.
 * Components that use these hooks re-render only when the selected subset
 * of the context value changes (React still re-renders on any context
 * change, but the component itself reads fewer fields, making it easier
 * to migrate to a split-context approach in the future).
 *
 * RULES:
 * - Never import from here inside CRMContext itself.
 * - Add new selectors as needed; keep each selector tightly scoped.
 */

import { useCRM } from '@/context/CRMContext';

// ---------------------------------------------------------------------------
// AI configuration — used by AIConfigSection and similar settings components
// ---------------------------------------------------------------------------

export function useAIConfig() {
  const ctx = useCRM();
  return {
    aiProvider: ctx.aiProvider,
    setAiProvider: ctx.setAiProvider,
    aiApiKey: ctx.aiApiKey,
    setAiApiKey: ctx.setAiApiKey,
    aiModel: ctx.aiModel,
    setAiModel: ctx.setAiModel,
    aiKeyConfigured: ctx.aiKeyConfigured,
    aiThinking: ctx.aiThinking,
    setAiThinking: ctx.setAiThinking,
    aiSearch: ctx.aiSearch,
    setAiSearch: ctx.setAiSearch,
    aiAnthropicCaching: ctx.aiAnthropicCaching,
    setAiAnthropicCaching: ctx.setAiAnthropicCaching,
  };
}

// ---------------------------------------------------------------------------
// Dashboard data — activities feed, lifecycle stages, contacts, boards
// ---------------------------------------------------------------------------

export function useDashboardCRM() {
  const ctx = useCRM();
  return {
    activities: ctx.activities,
    lifecycleStages: ctx.lifecycleStages,
    contacts: ctx.contacts,
    boards: ctx.boards,
  };
}

// ---------------------------------------------------------------------------
// Deal Cockpit — everything the cockpit view needs from CRM
// ---------------------------------------------------------------------------

export function useCockpitCRM() {
  const ctx = useCRM();
  return {
    loading: ctx.loading,
    error: ctx.error,
    refresh: ctx.refresh,
    deals: ctx.deals,
    contacts: ctx.contacts,
    boards: ctx.boards,
    activities: ctx.activities,
    addActivity: ctx.addActivity,
    updateDeal: ctx.updateDeal,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle stages — used by Kanban and any component that renders stage names
// ---------------------------------------------------------------------------

export function useLifecycleStages() {
  const { lifecycleStages } = useCRM();
  return lifecycleStages;
}

// ---------------------------------------------------------------------------
// AI feature flags — used by AIFeaturesSection to toggle per-feature AI flags
// ---------------------------------------------------------------------------

export function useAIFeatureFlags() {
  const { aiFeatureFlags, setAIFeatureFlag } = useCRM();
  return { aiFeatureFlags, setAIFeatureFlag };
}
