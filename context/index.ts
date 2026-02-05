// Export all individual contexts
export { DealsProvider, useDeals, useDealsView } from './deals/DealsContext';
export { ContactsProvider, useContacts } from './contacts/ContactsContext';
export { ActivitiesProvider, useActivities } from './activities/ActivitiesContext';
export { BoardsProvider, useBoards } from './boards/BoardsContext';
export { SettingsProvider, useSettings } from './settings/SettingsContext';
export { MessagingProvider, useMessaging } from './messaging';
export type { MessagingContextType } from './messaging';

// Export combined provider and legacy hook
export { CRMProvider, useCRM } from './CRMContext';
