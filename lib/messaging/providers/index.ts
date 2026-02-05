/**
 * @fileoverview Channel Providers Index
 *
 * Exports all channel providers and registers them with the factory.
 *
 * @module lib/messaging/providers
 */

// Base provider
export { BaseChannelProvider } from './base.provider';

// WhatsApp providers
export { ZApiWhatsAppProvider } from './whatsapp';
export type { ZApiCredentials, ZApiWebhookPayload } from './whatsapp';

// =============================================================================
// FACTORY REGISTRATION
// =============================================================================

import { registerProvider } from '../channel-factory';
import { ZApiWhatsAppProvider } from './whatsapp';

// Register Z-API provider
registerProvider({
  channelType: 'whatsapp',
  providerName: 'z-api',
  constructor: ZApiWhatsAppProvider,
  displayName: 'Z-API',
  description: 'WhatsApp via Z-API (não oficial, baseado em QR code)',
  configFields: [
    {
      key: 'instanceId',
      label: 'Instance ID',
      type: 'text',
      required: true,
      placeholder: 'seu-instance-id',
    },
    {
      key: 'token',
      label: 'Token',
      type: 'password',
      required: true,
      placeholder: 'seu-token',
    },
    {
      key: 'clientToken',
      label: 'Client Token (opcional)',
      type: 'password',
      required: false,
      placeholder: 'seu-client-token',
    },
  ],
  features: ['media', 'read_receipts', 'qr_code'],
});

// Future: Register Meta Cloud API provider
// registerProvider({
//   channelType: 'whatsapp',
//   providerName: 'meta-cloud',
//   constructor: MetaCloudWhatsAppProvider,
//   ...
// });
