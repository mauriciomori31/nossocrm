import { createClient } from '@/lib/supabase/server';
import { isAllowedOrigin } from '@/lib/security/sameOrigin';
import { ChannelProviderFactory } from '@/lib/messaging';
import type { MessageContent, TextContent } from '@/lib/messaging/types';

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * POST /api/messaging/messages
 * Envia uma nova mensagem
 */
export async function POST(req: Request) {
  if (!isAllowedOrigin(req)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, role, organization_id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile?.organization_id) {
    return json({ error: 'Profile not found' }, 404);
  }

  let body: {
    conversationId: string;
    content: MessageContent;
    replyToMessageId?: string;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Validação básica
  if (!body.conversationId) {
    return json({ error: 'Missing required field: conversationId' }, 400);
  }

  if (!body.content || !body.content.type) {
    return json({ error: 'Missing required field: content' }, 400);
  }

  // Buscar conversa com canal
  const { data: conversation, error: convError } = await supabase
    .from('messaging_conversations')
    .select(`
      id,
      organization_id,
      channel_id,
      external_contact_id,
      window_expires_at,
      messaging_channels (
        id,
        channel_type,
        provider,
        external_identifier,
        credentials,
        status
      )
    `)
    .eq('id', body.conversationId)
    .eq('organization_id', profile.organization_id)
    .single();

  if (convError || !conversation) {
    return json({ error: 'Conversation not found' }, 404);
  }

  const channel = conversation.messaging_channels as unknown as {
    id: string;
    channel_type: string;
    provider: string;
    external_identifier: string;
    credentials: Record<string, string>;
    status: string;
  };

  if (!channel) {
    return json({ error: 'Channel not found for conversation' }, 404);
  }

  // Verificar se canal está conectado
  if (channel.status !== 'connected') {
    return json({ error: 'Channel is not connected' }, 400);
  }

  // Verificar janela de 24h para WhatsApp/Instagram
  if (['whatsapp', 'instagram'].includes(channel.channel_type)) {
    if (conversation.window_expires_at) {
      const windowExpired = new Date(conversation.window_expires_at) < new Date();
      if (windowExpired && body.content.type !== 'template') {
        return json({
          error: 'Response window expired. Use a template message to re-engage.',
          windowExpired: true,
        }, 400);
      }
    }
  }

  try {
    // Criar provider
    const provider = ChannelProviderFactory.createProvider(
      channel.channel_type as 'whatsapp' | 'instagram' | 'email' | 'sms' | 'telegram' | 'voice',
      channel.provider
    );

    await provider.initialize({
      channelId: channel.id,
      channelType: channel.channel_type as 'whatsapp' | 'instagram' | 'email' | 'sms' | 'telegram' | 'voice',
      provider: channel.provider,
      externalIdentifier: channel.external_identifier,
      credentials: channel.credentials,
    });

    // Criar mensagem no banco primeiro (status pending)
    const { data: message, error: msgError } = await supabase
      .from('messaging_messages')
      .insert({
        conversation_id: body.conversationId,
        direction: 'outbound',
        content_type: body.content.type,
        content: body.content as unknown as Record<string, unknown>,
        reply_to_message_id: body.replyToMessageId || null,
        status: 'pending',
        sender_name: profile.id, // ID do usuário que enviou
      })
      .select()
      .single();

    if (msgError) {
      console.error('Error creating message:', msgError);
      return json({ error: 'Failed to create message' }, 500);
    }

    // Enviar via provider
    const result = await provider.sendMessage({
      conversationId: body.conversationId,
      to: conversation.external_contact_id,
      content: body.content,
      replyToMessageId: body.replyToMessageId,
    });

    if (result.success && result.externalMessageId) {
      // Atualizar mensagem com ID externo e status sent
      await supabase
        .from('messaging_messages')
        .update({
          external_id: result.externalMessageId,
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
        .eq('id', message.id);

      // Atualizar conversa
      await supabase
        .from('messaging_conversations')
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: getMessagePreview(body.content),
          last_message_direction: 'outbound',
          updated_at: new Date().toISOString(),
        })
        .eq('id', body.conversationId);

      return json({
        message: {
          ...message,
          external_id: result.externalMessageId,
          status: 'sent',
          sent_at: new Date().toISOString(),
        }
      }, 201);
    } else {
      // Marcar mensagem como falha
      await supabase
        .from('messaging_messages')
        .update({
          status: 'failed',
          error_code: result.error?.code,
          error_message: result.error?.message,
          failed_at: new Date().toISOString(),
        })
        .eq('id', message.id);

      return json({
        error: result.error?.message || 'Failed to send message',
        messageId: message.id,
      }, 500);
    }
  } catch (error) {
    console.error('Error sending message:', error);
    return json({
      error: error instanceof Error ? error.message : 'Failed to send message'
    }, 500);
  }
}

/**
 * Helper para extrair preview da mensagem
 */
function getMessagePreview(content: MessageContent): string {
  switch (content.type) {
    case 'text':
      return (content as TextContent).text.slice(0, 100);
    case 'image':
      return (content as { caption?: string }).caption || '[Imagem]';
    case 'video':
      return (content as { caption?: string }).caption || '[Vídeo]';
    case 'audio':
      return '[Áudio]';
    case 'document':
      return (content as { fileName?: string }).fileName || '[Documento]';
    case 'sticker':
      return '[Sticker]';
    case 'location':
      return (content as { name?: string }).name || '[Localização]';
    case 'template':
      return `[Template: ${(content as { templateName: string }).templateName}]`;
    default:
      return '[Mensagem]';
  }
}
