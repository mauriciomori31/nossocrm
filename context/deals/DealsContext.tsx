import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
  ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Deal, DealView, DealItem, Company, Contact, Board } from '@/types';
import { dealsService } from '@/lib/supabase';
import { useAuth } from '../AuthContext';
import { queryKeys, DEALS_VIEW_KEY } from '@/lib/query';
import { useDeals as useTanStackDealsQuery, useCreateDeal } from '@/lib/query/hooks/useDealsQuery';

interface DealsContextType {
  // Raw data (agora vem direto do TanStack Query)
  rawDeals: Deal[];
  loading: boolean;
  error: string | null;

  // CRUD Operations
  addDeal: (deal: Omit<Deal, 'id' | 'createdAt'>) => Promise<Deal | null>;
  updateDeal: (id: string, updates: Partial<Deal>) => Promise<void>;
  updateDealStatus: (id: string, newStatus: string, lossReason?: string) => Promise<void>;
  deleteDeal: (id: string) => Promise<void>;

  // Items
  addItemToDeal: (dealId: string, item: Omit<DealItem, 'id'>) => Promise<DealItem | null>;
  removeItemFromDeal: (dealId: string, itemId: string) => Promise<void>;

  // Refresh
  refresh: () => Promise<void>;
}

const DealsContext = createContext<DealsContextType | undefined>(undefined);

/**
 * Componente React `DealsProvider`.
 *
 * @param {{ children: ReactNode; }} { children } - Parâmetro `{ children }`.
 * @returns {Element} Retorna um valor do tipo `Element`.
 */
export const DealsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const createDealMutation = useCreateDeal();

  // ============================================
  // TanStack Query como fonte única de verdade
  // ============================================
  const {
    data: rawDeals = [],
    isLoading: loading,
    error: queryError,
  } = useTanStackDealsQuery();

  // Converte erro do TanStack Query para string
  const error = queryError ? (queryError as Error).message : null;

  // Refresh = invalidar cache do TanStack Query
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.deals.all });
  }, [queryClient]);

  // ============================================
  // CRUD Operations - Usam service + invalidam cache
  // ============================================
  const addDeal = useCallback(
    async (deal: Omit<Deal, 'id' | 'createdAt'>): Promise<Deal | null> => {
      if (!profile) {
        console.error('Usuário não autenticado');
        return null;
      }
      try {
        // Delega para useCreateDeal que já faz optimistic insert em DEALS_VIEW_KEY
        // Strip updatedAt: CreateDealInput omite esse campo (mutationFn define internamente)
        // isWon e isLost já são boolean required em Omit<Deal, 'id' | 'createdAt'>,
        // satisfazendo diretamente os campos optional de CreateDealInput — sem cast necessário
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { updatedAt: _, ...createInput } = deal;
        const data = await createDealMutation.mutateAsync(createInput);
        return data;
      } catch (error) {
        console.error('Erro ao criar deal:', (error as Error).message);
        return null;
      }
    },
    [profile, createDealMutation]
  );

  const updateDeal = useCallback(async (id: string, updates: Partial<Deal>) => {
    // Cancel background refetches to prevent overwriting optimistic update
    await queryClient.cancelQueries({ queryKey: DEALS_VIEW_KEY });

    // Snapshot for rollback
    const previousDeals = queryClient.getQueryData<DealView[]>(DEALS_VIEW_KEY);

    // Optimistic update
    queryClient.setQueryData<DealView[]>(DEALS_VIEW_KEY, (old = []) =>
      old.map(deal =>
        deal.id === id ? { ...deal, ...updates, updatedAt: new Date().toISOString() } : deal
      )
    );

    const { error: updateError } = await dealsService.update(id, updates);

    if (updateError) {
      console.error('Erro ao atualizar deal:', updateError.message);
      // Rollback usando snapshot
      if (previousDeals !== undefined) {
        queryClient.setQueryData(DEALS_VIEW_KEY, previousDeals);
      } else {
        // Cache estava frio — sem snapshot para restaurar, força refetch
        await queryClient.invalidateQueries({ queryKey: DEALS_VIEW_KEY });
      }
      return;
    }

    // Sucesso: Realtime vai sincronizar.
  }, [queryClient]);

  const updateDealStatus = useCallback(
    async (id: string, newStatus: string, lossReason?: string) => {
      const updates: Partial<Deal> = {
        status: newStatus as Deal['status'],
        lastStageChangeDate: new Date().toISOString(),
        ...(lossReason && { lossReason }),
        ...(newStatus === 'WON' && { closedAt: new Date().toISOString(), isWon: true }),
        ...(newStatus === 'LOST' && { closedAt: new Date().toISOString(), isLost: true }),
      };

      await updateDeal(id, updates);
    },
    [updateDeal]
  );

  const deleteDeal = useCallback(async (id: string) => {
    // Cancel background refetches to prevent overwriting optimistic update
    await queryClient.cancelQueries({ queryKey: DEALS_VIEW_KEY });

    // Snapshot for rollback
    const previousDeals = queryClient.getQueryData<DealView[]>(DEALS_VIEW_KEY);

    // Optimistic update - remove da UI imediatamente
    queryClient.setQueryData<DealView[]>(DEALS_VIEW_KEY, (old = []) =>
      old.filter(deal => deal.id !== id)
    );

    const { error: deleteError } = await dealsService.delete(id);

    if (deleteError) {
      console.error('Erro ao deletar deal:', deleteError.message);
      // Rollback usando snapshot
      if (previousDeals !== undefined) {
        queryClient.setQueryData(DEALS_VIEW_KEY, previousDeals);
      } else {
        // Cache estava frio — sem snapshot para restaurar, força refetch
        await queryClient.invalidateQueries({ queryKey: DEALS_VIEW_KEY });
      }
      return;
    }

    // Sucesso: atualiza stats do dashboard
    await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.stats });
  }, [queryClient]);

  // ============================================
  // Items Operations
  // ============================================
  const addItemToDeal = useCallback(
    async (dealId: string, item: Omit<DealItem, 'id'>): Promise<DealItem | null> => {
      const { data, error: addError } = await dealsService.addItem(dealId, item);

      if (addError) {
        console.error('Erro ao adicionar item:', addError.message);
        return null;
      }

      // Invalida cache para TanStack Query atualizar
      await queryClient.invalidateQueries({ queryKey: queryKeys.deals.all });

      return data;
    },
    [queryClient]
  );

  const removeItemFromDeal = useCallback(async (dealId: string, itemId: string) => {
    const { error: removeError } = await dealsService.removeItem(dealId, itemId);

    if (removeError) {
      console.error('Erro ao remover item:', removeError.message);
      return;
    }

    // Invalida cache para TanStack Query atualizar
    await queryClient.invalidateQueries({ queryKey: queryKeys.deals.all });
  }, [queryClient]);

  const value = useMemo(
    () => ({
      rawDeals,
      loading,
      error,
      addDeal,
      updateDeal,
      updateDealStatus,
      deleteDeal,
      addItemToDeal,
      removeItemFromDeal,
      refresh,
    }),
    [
      rawDeals,
      loading,
      error,
      addDeal,
      updateDeal,
      updateDealStatus,
      deleteDeal,
      addItemToDeal,
      removeItemFromDeal,
      refresh,
    ]
  );

  return <DealsContext.Provider value={value}>{children}</DealsContext.Provider>;
};

/**
 * Hook React `useDeals` que encapsula uma lógica reutilizável.
 * @returns {DealsContextType} Retorna um valor do tipo `DealsContextType`.
 */
export const useDeals = () => {
  const context = useContext(DealsContext);
  if (context === undefined) {
    throw new Error('useDeals must be used within a DealsProvider');
  }
  return context;
};

// Hook para deals com view projection (desnormalizado)
/**
 * Hook React `useDealsView` que encapsula uma lógica reutilizável.
 *
 * @param {Record<string, Organization>} companyMap - Parâmetro `companyMap`.
 * @param {Record<string, Contact>} contactMap - Parâmetro `contactMap`.
 * @param {Board[]} boards - Parâmetro `boards`.
 * @returns {DealView[]} Retorna um valor do tipo `DealView[]`.
 */
export const useDealsView = (
  companyMap: Record<string, Company>,
  contactMap: Record<string, Contact>,
  boards: Board[] = []
): DealView[] => {
  const { rawDeals } = useDeals();

  // Pre-build Maps para lookups O(1) ao invés de O(n) com .find()
  // Isso reduz de O(deals * boards * stages) para O(deals + boards + stages)
  const boardMap = useMemo(() => {
    const map = new Map<string, Board>();
    for (const board of boards) {
      map.set(board.id, board);
    }
    return map;
  }, [boards]);

  // Map de stageId -> stageLabel para lookup direto O(1)
  const stageLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const board of boards) {
      if (board.stages) {
        for (const stage of board.stages) {
          map.set(stage.id, stage.label);
        }
      }
    }
    return map;
  }, [boards]);

  return useMemo(() => {
    return rawDeals.map(deal => {
      // Lookups O(1) usando Maps pré-construídos
      const stageLabel = stageLabelMap.get(deal.status) || 'Desconhecido';

      return {
        ...deal,
        companyName: deal.companyId ? companyMap[deal.companyId]?.name : undefined,
        clientCompanyName: (deal.clientCompanyId || deal.companyId)
          ? companyMap[(deal.clientCompanyId || deal.companyId) as string]?.name
          : undefined,
        contactName: deal.contactId ? (contactMap[deal.contactId]?.name || 'Sem Contato') : 'Sem Contato',
        contactEmail: deal.contactId ? (contactMap[deal.contactId]?.email || '') : '',
        stageLabel,
      };
    });
  }, [rawDeals, companyMap, contactMap, stageLabelMap]);
};
