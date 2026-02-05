/**
 * Z-API Webhook Handler
 *
 * Recebe eventos do Z-API (mensagens, status, etc.) e processa:
 * - Mensagens recebidas → cria/atualiza conversa + insere mensagem
 * - Status updates → atualiza status da mensagem
 *
 * Rota:
 * - `POST /functions/v1/messaging-webhook-zapi/<channel_id>`
 *
 * Autenticação:
 * - Header `X-Webhook-Secret: <secret>` ou
 * - Header `Authorization: Bearer <secret>`
 * - Valor deve bater com o secret configurado no canal
 */
import { createClient } from "npm:@supabase/supabase-js@2";

// =============================================================================
// TYPES
// =============================================================================

interface ZApiWebhookPayload {
  // Message identification
  messageId?: string;
  zapiMessageId?: string;

  // Contact info
  phone?: string;
  chatId?: string;
  instanceId?: string;

  // Message details
  fromMe?: boolean;
  moment?: number;
  type?: string;

  // Content by type
  text?: { message: string };
  image?: { imageUrl: string; caption?: string; mimeType?: string };
  video?: { videoUrl: string; caption?: string; mimeType?: string };
  audio?: { audioUrl: string; mimeType?: string };
  document?: { documentUrl: string; fileName?: string; mimeType?: string };
  sticker?: { stickerUrl: string };
  location?: { latitude: number; longitude: number; name?: string };

  // Contact info in message
  senderName?: string;
  senderPhoto?: string;

  // Status updates
  status?: "SENT" | "DELIVERED" | "READ" | "PLAYED";
  ids?: string[];

  // Error info
  error?: string;
  errorMessage?: string;
}

interface MessageContent {
  type: string;
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  caption?: string;
  fileName?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Webhook-Secret, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function getChannelIdFromPath(req: Request): string | null {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => p === "messaging-webhook-zapi");
  if (idx === -1) return null;
  return parts[idx + 1] ?? null;
}

function getSecretFromRequest(req: Request): string {
  const xSecret = req.headers.get("X-Webhook-Secret") || "";
  if (xSecret.trim()) return xSecret.trim();

  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1]) return m[1].trim();

  return "";
}

function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  // Remove non-digits and add +
  const digits = phone.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

function extractContent(data: ZApiWebhookPayload): MessageContent {
  if (data.text) {
    return {
      type: "text",
      text: data.text.message,
    };
  }

  if (data.image) {
    return {
      type: "image",
      mediaUrl: data.image.imageUrl,
      mimeType: data.image.mimeType || "image/jpeg",
      caption: data.image.caption,
    };
  }

  if (data.video) {
    return {
      type: "video",
      mediaUrl: data.video.videoUrl,
      mimeType: data.video.mimeType || "video/mp4",
      caption: data.video.caption,
    };
  }

  if (data.audio) {
    return {
      type: "audio",
      mediaUrl: data.audio.audioUrl,
      mimeType: data.audio.mimeType || "audio/ogg",
    };
  }

  if (data.document) {
    return {
      type: "document",
      mediaUrl: data.document.documentUrl,
      fileName: data.document.fileName || "document",
      mimeType: data.document.mimeType || "application/pdf",
    };
  }

  if (data.sticker) {
    return {
      type: "sticker",
      mediaUrl: data.sticker.stickerUrl,
      mimeType: "image/webp",
    };
  }

  if (data.location) {
    return {
      type: "location",
      latitude: data.location.latitude,
      longitude: data.location.longitude,
      name: data.location.name,
    };
  }

  return {
    type: "text",
    text: `[${data.type || "unknown"}]`,
  };
}

function getMessagePreview(content: MessageContent): string {
  switch (content.type) {
    case "text":
      return (content.text || "").slice(0, 100);
    case "image":
      return content.caption || "[Imagem]";
    case "video":
      return content.caption || "[Vídeo]";
    case "audio":
      return "[Áudio]";
    case "document":
      return content.fileName || "[Documento]";
    case "sticker":
      return "[Sticker]";
    case "location":
      return content.name || "[Localização]";
    default:
      return "[Mensagem]";
  }
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Método não permitido" });
  }

  const channelId = getChannelIdFromPath(req);
  if (!channelId) {
    return json(404, { error: "channel_id ausente na URL" });
  }

  // Parse payload
  let payload: ZApiWebhookPayload;
  try {
    payload = (await req.json()) as ZApiWebhookPayload;
  } catch {
    return json(400, { error: "JSON inválido" });
  }

  // Setup Supabase client
  const supabaseUrl =
    Deno.env.get("CRM_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL");
  const serviceKey =
    Deno.env.get("CRM_SUPABASE_SECRET_KEY") ??
    Deno.env.get("CRM_SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: "Supabase não configurado no runtime" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Fetch channel and validate
  const { data: channel, error: channelErr } = await supabase
    .from("messaging_channels")
    .select("id, organization_id, business_unit_id, external_identifier, credentials, status")
    .eq("id", channelId)
    .is("deleted_at", null)
    .maybeSingle();

  if (channelErr) {
    return json(500, { error: "Erro ao buscar canal", details: channelErr.message });
  }

  if (!channel) {
    return json(404, { error: "Canal não encontrado" });
  }

  // Validate secret (optional - Z-API pode não enviar secret)
  const secretHeader = getSecretFromRequest(req);
  const channelSecret = (channel.credentials as Record<string, unknown>)?.webhookSecret;

  if (channelSecret && secretHeader && String(channelSecret) !== String(secretHeader)) {
    return json(401, { error: "Secret inválido" });
  }

  // Log webhook event for audit
  const externalEventId = payload.messageId || payload.zapiMessageId || `${Date.now()}`;

  const { error: eventInsertErr } = await supabase
    .from("messaging_webhook_events")
    .insert({
      channel_id: channelId,
      event_type: determineEventType(payload),
      external_event_id: externalEventId,
      payload: payload as unknown as Record<string, unknown>,
      processed: false,
    });

  // Ignore duplicate key errors (idempotency)
  if (eventInsertErr && !eventInsertErr.message.toLowerCase().includes("duplicate")) {
    console.error("Error logging webhook event:", eventInsertErr);
  }

  try {
    // Determine event type and process
    if (payload.status && payload.ids) {
      // Status update
      await handleStatusUpdate(supabase, channel, payload);
    } else if (payload.phone && !payload.fromMe) {
      // Inbound message
      await handleInboundMessage(supabase, channel, payload);
    } else if (payload.phone && payload.fromMe) {
      // Outbound message confirmation (our message was sent)
      await handleOutboundConfirmation(supabase, channel, payload);
    }

    // Mark event as processed
    await supabase
      .from("messaging_webhook_events")
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq("channel_id", channelId)
      .eq("external_event_id", externalEventId);

    return json(200, { ok: true, event_type: determineEventType(payload) });
  } catch (error) {
    console.error("Webhook processing error:", error);

    // Log error in webhook event
    await supabase
      .from("messaging_webhook_events")
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      })
      .eq("channel_id", channelId)
      .eq("external_event_id", externalEventId);

    return json(500, {
      error: "Erro ao processar webhook",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// =============================================================================
// EVENT HANDLERS
// =============================================================================

function determineEventType(payload: ZApiWebhookPayload): string {
  if (payload.error || payload.errorMessage) return "error";
  if (payload.status && payload.ids) return "status_update";
  if (payload.phone && !payload.fromMe) return "message_received";
  if (payload.phone && payload.fromMe) return "message_sent";
  return "unknown";
}

async function handleInboundMessage(
  supabase: ReturnType<typeof createClient>,
  channel: {
    id: string;
    organization_id: string;
    business_unit_id: string;
    external_identifier: string;
  },
  payload: ZApiWebhookPayload
) {
  const phone = normalizePhone(payload.phone);
  if (!phone) throw new Error("Phone number is required");

  const externalMessageId = payload.messageId || payload.zapiMessageId || "";
  const content = extractContent(payload);
  const timestamp = payload.moment
    ? new Date(payload.moment * 1000)
    : new Date();

  // Find or create conversation
  const { data: existingConv, error: convFindErr } = await supabase
    .from("messaging_conversations")
    .select("id, contact_id, unread_count, message_count")
    .eq("channel_id", channel.id)
    .eq("external_contact_id", phone)
    .maybeSingle();

  if (convFindErr) throw convFindErr;

  let conversationId: string;

  if (existingConv) {
    conversationId = existingConv.id;
  } else {
    // Try to find existing contact by phone
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", channel.organization_id)
      .eq("phone", phone)
      .is("deleted_at", null)
      .maybeSingle();

    // Create new conversation
    const { data: newConv, error: convCreateErr } = await supabase
      .from("messaging_conversations")
      .insert({
        organization_id: channel.organization_id,
        channel_id: channel.id,
        business_unit_id: channel.business_unit_id,
        external_contact_id: phone,
        external_contact_name: payload.senderName || phone,
        external_contact_avatar: payload.senderPhoto,
        contact_id: contact?.id || null,
        status: "open",
        priority: "normal",
        // WhatsApp 24h window starts when customer sends message
        window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();

    if (convCreateErr) throw convCreateErr;
    conversationId = newConv.id;
  }

  // Insert message
  const { error: msgErr } = await supabase.from("messaging_messages").insert({
    conversation_id: conversationId,
    external_id: externalMessageId,
    direction: "inbound",
    content_type: content.type,
    content: content,
    status: "delivered", // Inbound messages are already delivered
    delivered_at: timestamp.toISOString(),
    sender_name: payload.senderName,
    sender_profile_url: payload.senderPhoto,
    metadata: {
      zapi_message_id: payload.zapiMessageId,
      moment: payload.moment,
    },
  });

  if (msgErr) {
    // Ignore duplicate messages
    if (!msgErr.message.toLowerCase().includes("duplicate")) {
      throw msgErr;
    }
  }

  // Update conversation counters (done by trigger, but also update window)
  await supabase
    .from("messaging_conversations")
    .update({
      last_message_at: timestamp.toISOString(),
      last_message_preview: getMessagePreview(content),
      last_message_direction: "inbound",
      // Reset 24h window on new inbound message
      window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      // Reopen if resolved
      status: "open",
    })
    .eq("id", conversationId);
}

async function handleOutboundConfirmation(
  supabase: ReturnType<typeof createClient>,
  channel: { id: string },
  payload: ZApiWebhookPayload
) {
  const externalMessageId = payload.messageId || payload.zapiMessageId;
  if (!externalMessageId) return;

  // Update message with external ID if not already set
  await supabase
    .from("messaging_messages")
    .update({
      external_id: externalMessageId,
      status: "sent",
      sent_at: new Date().toISOString(),
    })
    .eq("external_id", externalMessageId)
    .is("sent_at", null);
}

async function handleStatusUpdate(
  supabase: ReturnType<typeof createClient>,
  channel: { id: string },
  payload: ZApiWebhookPayload
) {
  const statusMap: Record<string, { status: string; field: string }> = {
    SENT: { status: "sent", field: "sent_at" },
    DELIVERED: { status: "delivered", field: "delivered_at" },
    READ: { status: "read", field: "read_at" },
    PLAYED: { status: "read", field: "read_at" },
  };

  const mapping = statusMap[payload.status || ""];
  if (!mapping) return;

  const now = new Date().toISOString();

  // Update all affected messages
  for (const externalId of payload.ids || []) {
    await supabase
      .from("messaging_messages")
      .update({
        status: mapping.status,
        [mapping.field]: now,
      })
      .eq("external_id", externalId);
  }
}
