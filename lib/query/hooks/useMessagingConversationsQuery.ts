/**
 * @fileoverview TanStack Query hooks for Messaging Conversations
 *
 * Conversations are threads of messages with external contacts.
 * They belong to a channel and can be linked to CRM contacts.
 *
 * @module lib/query/hooks/useMessagingConversationsQuery
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { queryKeys } from '../queryKeys';
import { getClient } from '@/lib/supabase/client';
import { useAuth } from '@/context/AuthContext';
import type {
  MessagingConversation,
  ConversationView,
  ConversationFilters,
  ConversationStatus,
  UpdateConversationInput,
} from '@/lib/messaging/types';
import {
  transformConversation,
  isWindowExpired,
  getWindowMinutesRemaining,
} from '@/lib/messaging/types';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_PAGE_SIZE = 50;

// =============================================================================
// QUERY HOOKS
// =============================================================================

/**
 * Fetch conversations with filters (inbox view).
 * Returns ConversationView with denormalized data.
 */
export function useMessagingConversations(filters?: ConversationFilters) {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingConversations.filtered(filters),
    queryFn: async (): Promise<ConversationView[]> => {
      const supabase = getClient();

      let query = supabase
        .from('messaging_conversations')
        .select(`
          *,
          channel:messaging_channels!channel_id (
            id,
            channel_type,
            name
          ),
          contact:contacts!contact_id (
            id,
            name,
            email,
            phone
          ),
          assigned_user:profiles!assigned_user_id (
            id,
            name,
            avatar
          )
        `);

      // Apply filters
      if (filters?.status && filters.status !== 'all') {
        query = query.eq('status', filters.status);
      }
      if (filters?.channelId) {
        query = query.eq('channel_id', filters.channelId);
      }
      if (filters?.businessUnitId) {
        query = query.eq('business_unit_id', filters.businessUnitId);
      }
      if (filters?.assignedUserId) {
        if (filters.assignedUserId === 'unassigned') {
          query = query.is('assigned_user_id', null);
        } else {
          query = query.eq('assigned_user_id', filters.assignedUserId);
        }
      }
      if (filters?.hasUnread) {
        query = query.gt('unread_count', 0);
      }
      if (filters?.search) {
        query = query.or(`external_contact_name.ilike.%${filters.search}%,last_message_preview.ilike.%${filters.search}%`);
      }

      // Apply sorting
      const sortBy = filters?.sortBy || 'lastMessageAt';
      const sortOrder = filters?.sortOrder || 'desc';
      const sortColumn = sortBy === 'lastMessageAt' ? 'last_message_at' :
                        sortBy === 'createdAt' ? 'created_at' : 'unread_count';
      query = query.order(sortColumn, { ascending: sortOrder === 'asc', nullsFirst: false });

      const { data, error } = await query.limit(100);

      if (error) throw error;

      // Transform to ConversationView
      return (data || []).map((row) => {
        const base = transformConversation(row);
        const channel = row.channel as { id?: string; channel_type?: string; name?: string } | null;
        const contact = row.contact as { id?: string; name?: string; email?: string; phone?: string } | null;
        const assignedUser = row.assigned_user as { id?: string; name?: string; avatar?: string } | null;

        return {
          ...base,
          channelType: channel?.channel_type as ConversationView['channelType'],
          channelName: channel?.name || '',
          contactName: contact?.name,
          contactEmail: contact?.email,
          contactPhone: contact?.phone,
          assignedUserName: assignedUser?.name,
          assignedUserAvatar: assignedUser?.avatar,
          isWindowExpired: isWindowExpired(base),
          windowMinutesRemaining: getWindowMinutesRemaining(base),
        };
      });
    },
    staleTime: 30 * 1000, // 30 seconds (conversations change frequently)
    enabled: !authLoading && !!user,
  });
}

/**
 * Fetch conversations for a specific channel.
 */
export function useConversationsByChannel(channelId: string | undefined) {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingConversations.byChannel(channelId || ''),
    queryFn: async (): Promise<MessagingConversation[]> => {
      if (!channelId) return [];

      const supabase = getClient();

      const { data, error } = await supabase
        .from('messaging_conversations')
        .select('*')
        .eq('channel_id', channelId)
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (error) throw error;
      return (data || []).map(transformConversation);
    },
    staleTime: 30 * 1000,
    enabled: !authLoading && !!user && !!channelId,
  });
}

/**
 * Fetch conversations for a specific contact.
 */
export function useConversationsByContact(contactId: string | undefined) {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingConversations.byContact(contactId || ''),
    queryFn: async (): Promise<MessagingConversation[]> => {
      if (!contactId) return [];

      const supabase = getClient();

      const { data, error } = await supabase
        .from('messaging_conversations')
        .select('*')
        .eq('contact_id', contactId)
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (error) throw error;
      return (data || []).map(transformConversation);
    },
    staleTime: 30 * 1000,
    enabled: !authLoading && !!user && !!contactId,
  });
}

/**
 * Fetch a single conversation by ID with full details.
 */
export function useMessagingConversation(conversationId: string | undefined) {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingConversations.detail(conversationId || ''),
    queryFn: async (): Promise<ConversationView | null> => {
      if (!conversationId) return null;

      const supabase = getClient();

      const { data, error } = await supabase
        .from('messaging_conversations')
        .select(`
          *,
          channel:messaging_channels!channel_id (
            id,
            channel_type,
            name,
            provider
          ),
          contact:contacts!contact_id (
            id,
            name,
            email,
            phone,
            avatar
          ),
          assigned_user:profiles!assigned_user_id (
            id,
            name,
            avatar
          )
        `)
        .eq('id', conversationId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      const base = transformConversation(data);
      const channel = data.channel as { id?: string; channel_type?: string; name?: string } | null;
      const contact = data.contact as { id?: string; name?: string; email?: string; phone?: string } | null;
      const assignedUser = data.assigned_user as { id?: string; name?: string; avatar?: string } | null;

      return {
        ...base,
        channelType: channel?.channel_type as ConversationView['channelType'],
        channelName: channel?.name || '',
        contactName: contact?.name,
        contactEmail: contact?.email,
        contactPhone: contact?.phone,
        assignedUserName: assignedUser?.name,
        assignedUserAvatar: assignedUser?.avatar,
        isWindowExpired: isWindowExpired(base),
        windowMinutesRemaining: getWindowMinutesRemaining(base),
      };
    },
    staleTime: 30 * 1000,
    enabled: !authLoading && !!user && !!conversationId,
  });
}

/**
 * Fetch unread conversation count.
 */
export function useUnreadConversationCount() {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingConversations.unreadCount(),
    queryFn: async (): Promise<number> => {
      const supabase = getClient();

      const { data, error } = await supabase.rpc('get_messaging_unread_count');

      if (error) throw error;
      return data ?? 0;
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // Refetch every minute
    enabled: !authLoading && !!user,
  });
}

// =============================================================================
// MUTATION HOOKS
// =============================================================================

/**
 * Update a conversation (status, priority, assignment).
 */
export function useUpdateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      input,
    }: {
      conversationId: string;
      input: UpdateConversationInput;
    }): Promise<MessagingConversation> => {
      const supabase = getClient();

      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (input.status !== undefined) {
        updateData.status = input.status;
      }
      if (input.priority !== undefined) {
        updateData.priority = input.priority;
      }
      if (input.assignedUserId !== undefined) {
        updateData.assigned_user_id = input.assignedUserId;
        updateData.assigned_at = input.assignedUserId
          ? new Date().toISOString()
          : null;
      }

      const { data, error } = await supabase
        .from('messaging_conversations')
        .update(updateData)
        .eq('id', conversationId)
        .select()
        .single();

      if (error) throw error;

      return transformConversation(data);
    },
    onSuccess: (conversation) => {
      // Invalidate filtered queries
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.all,
      });
      // Update detail cache
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.detail(conversation.id),
      });
    },
  });
}

/**
 * Mark a conversation as read (reset unread count).
 */
export function useMarkConversationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string): Promise<void> => {
      const supabase = getClient();

      const { error } = await supabase.rpc('mark_conversation_read', {
        p_conversation_id: conversationId,
      });

      if (error) throw error;
    },
    onSuccess: (_, conversationId) => {
      // Update conversation detail
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.detail(conversationId),
      });
      // Update unread count
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.unreadCount(),
      });
      // Invalidate filtered queries
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.all,
      });
    },
  });
}

/**
 * Resolve (close) a conversation.
 */
export function useResolveConversation() {
  const updateConversation = useUpdateConversation();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      return updateConversation.mutateAsync({
        conversationId,
        input: { status: 'resolved' },
      });
    },
  });
}

/**
 * Reopen a conversation.
 */
export function useReopenConversation() {
  const updateConversation = useUpdateConversation();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      return updateConversation.mutateAsync({
        conversationId,
        input: { status: 'open' },
      });
    },
  });
}

/**
 * Assign a conversation to a user.
 */
export function useAssignConversation() {
  const updateConversation = useUpdateConversation();

  return useMutation({
    mutationFn: async ({
      conversationId,
      userId,
    }: {
      conversationId: string;
      userId: string | null;
    }) => {
      return updateConversation.mutateAsync({
        conversationId,
        input: { assignedUserId: userId },
      });
    },
  });
}

/**
 * Link a conversation to a CRM contact.
 */
export function useLinkConversationToContact() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      contactId,
    }: {
      conversationId: string;
      contactId: string | null;
    }): Promise<void> => {
      const supabase = getClient();

      const { error } = await supabase
        .from('messaging_conversations')
        .update({
          contact_id: contactId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);

      if (error) throw error;
    },
    onSuccess: (_, { conversationId, contactId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.detail(conversationId),
      });
      if (contactId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.messagingConversations.byContact(contactId),
        });
      }
    },
  });
}
