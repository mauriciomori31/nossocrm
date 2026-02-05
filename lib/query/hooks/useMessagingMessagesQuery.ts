/**
 * @fileoverview TanStack Query hooks for Messaging Messages
 *
 * Messages are individual communications within a conversation.
 * Supports various content types (text, media, templates).
 *
 * @module lib/query/hooks/useMessagingMessagesQuery
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import { queryKeys } from '../queryKeys';
import { getClient } from '@/lib/supabase/client';
import { useAuth } from '@/context/AuthContext';
import type {
  MessagingMessage,
  MessageContent,
  MessageStatus,
  SendMessageInput,
  PaginationState,
} from '@/lib/messaging/types';
import { transformMessage, createTextContent } from '@/lib/messaging/types';
import { getChannelRouter } from '@/lib/messaging';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_PAGE_SIZE = 50;

// =============================================================================
// TYPES
// =============================================================================

interface MessagesPage {
  messages: MessagingMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

// =============================================================================
// QUERY HOOKS
// =============================================================================

/**
 * Fetch messages for a conversation (paginated, most recent first).
 */
export function useMessagingMessages(
  conversationId: string | undefined,
  pagination?: PaginationState
) {
  const { user, loading: authLoading } = useAuth();
  const pageSize = pagination?.pageSize || DEFAULT_PAGE_SIZE;

  return useQuery({
    queryKey: queryKeys.messagingMessages.byConversation(conversationId || '', pagination),
    queryFn: async (): Promise<MessagingMessage[]> => {
      if (!conversationId) return [];

      const supabase = getClient();

      let query = supabase
        .from('messaging_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false });

      // Apply pagination
      if (pagination) {
        const from = pagination.pageIndex * pageSize;
        query = query.range(from, from + pageSize - 1);
      } else {
        query = query.limit(pageSize);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Return in chronological order for display
      return (data || []).map(transformMessage).reverse();
    },
    staleTime: 10 * 1000, // 10 seconds
    enabled: !authLoading && !!user && !!conversationId,
  });
}

/**
 * Fetch messages with infinite scroll (load more on scroll up).
 */
export function useMessagingMessagesInfinite(conversationId: string | undefined) {
  const { user, loading: authLoading } = useAuth();

  return useInfiniteQuery({
    queryKey: [...queryKeys.messagingMessages.byConversation(conversationId || ''), 'infinite'],
    queryFn: async ({ pageParam }): Promise<MessagesPage> => {
      if (!conversationId) {
        return { messages: [], nextCursor: null, hasMore: false };
      }

      const supabase = getClient();

      let query = supabase
        .from('messaging_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(DEFAULT_PAGE_SIZE + 1); // Fetch one extra to check hasMore

      // If we have a cursor, fetch messages before that timestamp
      if (pageParam) {
        query = query.lt('created_at', pageParam);
      }

      const { data, error } = await query;

      if (error) throw error;

      const messages = data || [];
      const hasMore = messages.length > DEFAULT_PAGE_SIZE;
      const pageMessages = hasMore ? messages.slice(0, -1) : messages;

      return {
        messages: pageMessages.map(transformMessage).reverse(),
        nextCursor: hasMore ? messages[messages.length - 1].created_at : null,
        hasMore,
      };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 10 * 1000,
    enabled: !authLoading && !!user && !!conversationId,
  });
}

/**
 * Fetch a single message by ID.
 */
export function useMessagingMessage(messageId: string | undefined) {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingMessages.detail(messageId || ''),
    queryFn: async (): Promise<MessagingMessage | null> => {
      if (!messageId) return null;

      const supabase = getClient();

      const { data, error } = await supabase
        .from('messaging_messages')
        .select('*')
        .eq('id', messageId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return transformMessage(data);
    },
    staleTime: 30 * 1000,
    enabled: !authLoading && !!user && !!messageId,
  });
}

// =============================================================================
// MUTATION HOOKS
// =============================================================================

/**
 * Send a message in a conversation.
 * This creates the message locally and sends it through the provider.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SendMessageInput): Promise<MessagingMessage> => {
      const supabase = getClient();

      // First, get the conversation to find the channel and recipient
      const { data: conversation, error: convError } = await supabase
        .from('messaging_conversations')
        .select('channel_id, external_contact_id')
        .eq('id', input.conversationId)
        .single();

      if (convError || !conversation) {
        throw new Error('Conversation not found');
      }

      // Create the message in pending state
      const contentType = input.content.type;
      const { data: message, error: msgError } = await supabase
        .from('messaging_messages')
        .insert({
          conversation_id: input.conversationId,
          direction: 'outbound',
          content_type: contentType,
          content: input.content,
          reply_to_message_id: input.replyToMessageId,
          status: 'pending',
        })
        .select()
        .single();

      if (msgError) throw msgError;

      // Send through the channel router
      const router = getChannelRouter();
      const result = await router.sendMessage(conversation.channel_id, {
        conversationId: input.conversationId,
        to: conversation.external_contact_id,
        content: input.content,
        replyToMessageId: input.replyToMessageId,
      });

      // Update the message with the result
      const updateData: Record<string, unknown> = {
        status: result.success ? 'sent' : 'failed',
      };

      if (result.success) {
        updateData.external_id = result.externalMessageId;
        updateData.sent_at = new Date().toISOString();
      } else {
        updateData.error_code = result.error?.code;
        updateData.error_message = result.error?.message;
        updateData.failed_at = new Date().toISOString();
      }

      const { data: updatedMessage, error: updateError } = await supabase
        .from('messaging_messages')
        .update(updateData)
        .eq('id', message.id)
        .select()
        .single();

      if (updateError) {
        console.error('[useSendMessage] Failed to update message status:', updateError);
      }

      return transformMessage(updatedMessage || message);
    },
    onMutate: async (input) => {
      // Optimistic update: add message to cache immediately
      const queryKey = queryKeys.messagingMessages.byConversation(input.conversationId);

      await queryClient.cancelQueries({ queryKey });

      const previousMessages = queryClient.getQueryData<MessagingMessage[]>(queryKey);

      // Create optimistic message
      const optimisticMessage: MessagingMessage = {
        id: `temp-${Date.now()}`,
        conversationId: input.conversationId,
        direction: 'outbound',
        contentType: input.content.type,
        content: input.content,
        replyToMessageId: input.replyToMessageId,
        status: 'pending',
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      queryClient.setQueryData<MessagingMessage[]>(queryKey, (old) => {
        return [...(old || []), optimisticMessage];
      });

      return { previousMessages, queryKey, optimisticMessage };
    },
    onError: (error, input, context) => {
      // Rollback on error
      if (context?.previousMessages !== undefined) {
        queryClient.setQueryData(context.queryKey, context.previousMessages);
      }
    },
    onSuccess: (message, input, context) => {
      // Replace optimistic message with real one
      queryClient.setQueryData<MessagingMessage[]>(context?.queryKey, (old) => {
        if (!old) return [message];
        return old.map((m) =>
          m.id === context?.optimisticMessage.id ? message : m
        );
      });

      // Also invalidate conversation to update last_message
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.detail(input.conversationId),
      });
    },
  });
}

/**
 * Send a text message (convenience wrapper).
 */
export function useSendTextMessage() {
  const sendMessage = useSendMessage();

  return useMutation({
    mutationFn: async ({
      conversationId,
      text,
      replyToMessageId,
    }: {
      conversationId: string;
      text: string;
      replyToMessageId?: string;
    }) => {
      return sendMessage.mutateAsync({
        conversationId,
        content: createTextContent(text),
        replyToMessageId,
      });
    },
  });
}

/**
 * Update message status (used by webhooks).
 */
export function useUpdateMessageStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      messageId,
      status,
      errorCode,
      errorMessage,
    }: {
      messageId: string;
      status: MessageStatus;
      errorCode?: string;
      errorMessage?: string;
    }): Promise<void> => {
      const supabase = getClient();

      const updateData: Record<string, unknown> = { status };

      // Set timestamp based on status
      const now = new Date().toISOString();
      switch (status) {
        case 'sent':
          updateData.sent_at = now;
          break;
        case 'delivered':
          updateData.delivered_at = now;
          break;
        case 'read':
          updateData.read_at = now;
          break;
        case 'failed':
          updateData.failed_at = now;
          updateData.error_code = errorCode;
          updateData.error_message = errorMessage;
          break;
      }

      const { error } = await supabase
        .from('messaging_messages')
        .update(updateData)
        .eq('id', messageId);

      if (error) throw error;
    },
    onSuccess: (_, { messageId }) => {
      // Invalidate the message
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingMessages.detail(messageId),
      });
    },
  });
}

/**
 * Retry a failed message.
 */
export function useRetryMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messageId: string): Promise<MessagingMessage> => {
      const supabase = getClient();

      // Get the original message
      const { data: message, error: msgError } = await supabase
        .from('messaging_messages')
        .select('*, conversation:messaging_conversations!conversation_id(channel_id, external_contact_id)')
        .eq('id', messageId)
        .single();

      if (msgError || !message) {
        throw new Error('Message not found');
      }

      if (message.status !== 'failed') {
        throw new Error('Can only retry failed messages');
      }

      // Reset to pending
      await supabase
        .from('messaging_messages')
        .update({
          status: 'pending',
          error_code: null,
          error_message: null,
          failed_at: null,
        })
        .eq('id', messageId);

      // Retry sending
      const router = getChannelRouter();
      const conversation = message.conversation as { channel_id: string; external_contact_id: string };

      const result = await router.sendMessage(conversation.channel_id, {
        conversationId: message.conversation_id,
        to: conversation.external_contact_id,
        content: message.content,
        replyToMessageId: message.reply_to_message_id,
      });

      // Update with result
      const updateData: Record<string, unknown> = {
        status: result.success ? 'sent' : 'failed',
      };

      if (result.success) {
        updateData.external_id = result.externalMessageId;
        updateData.sent_at = new Date().toISOString();
      } else {
        updateData.error_code = result.error?.code;
        updateData.error_message = result.error?.message;
        updateData.failed_at = new Date().toISOString();
      }

      const { data: updatedMessage, error: updateError } = await supabase
        .from('messaging_messages')
        .update(updateData)
        .eq('id', messageId)
        .select()
        .single();

      if (updateError) throw updateError;

      return transformMessage(updatedMessage);
    },
    onSuccess: (message) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingMessages.byConversation(message.conversationId),
      });
    },
  });
}
