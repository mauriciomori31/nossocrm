/**
 * @fileoverview Meeting Briefing Service
 *
 * Generates pre-meeting briefings for sales conversations.
 * Uses structured output to extract BANT status and actionable insights.
 *
 * @module lib/ai/briefing/briefing.service
 */

import { generateText, Output } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getModel } from '../config';
import { getOrgAIConfig } from '../agent/agent.service';
import { MeetingBriefingSchema, type BriefingResponse, type MeetingBriefing } from './schemas';

// =============================================================================
// Constants
// =============================================================================

const MAX_MESSAGES_FOR_BRIEFING = 50;

// =============================================================================
// System Prompt
// =============================================================================

const BRIEFING_SYSTEM_PROMPT = `Você é um assistente de vendas brasileiro especializado em preparar briefings pré-conversa.

IMPORTANTE: TODO o conteúdo gerado DEVE estar em PORTUGUÊS BRASILEIRO. Não use inglês em nenhuma parte da resposta.

Sua tarefa é analisar todo o histórico de comunicação com um lead e gerar um briefing estruturado que permita ao vendedor:
1. Entender rapidamente o contexto do deal
2. Saber exatamente onde parou a última conversa
3. Ter uma estratégia clara para a próxima interação

FRAMEWORK BANT (responda em português):
- Budget (Orçamento): Qual é o orçamento do lead? Foi mencionado? Está em negociação?
- Authority (Autoridade): Quem toma a decisão? Já identificamos o decisor?
- Need (Necessidade): Quais são as dores e necessidades? Foram validadas?
- Timeline (Prazo): Qual é a urgência? Existe deadline?

REGRAS:
- Seja conciso e acionável
- Extraia informações concretas das conversas, não invente
- Se algo não foi mencionado, use "Nenhuma informação disponível" (não use "unknown")
- Sugira perguntas específicas baseadas no contexto
- Alerte sobre riscos ou oportunidades identificados
- Sua confiança deve refletir a quantidade e qualidade de informações disponíveis
- SEMPRE responda em português brasileiro, nunca em inglês`;

// =============================================================================
// Context Building (Deal-based)
// =============================================================================

interface DealContext {
  deal: {
    id: string;
    title: string;
    value: number | null;
    stageName: string;
    createdAt: string;
    customFields: Record<string, unknown>;
  };
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    position: string | null;
  } | null;
  stage: {
    name: string;
    goal: string | null;
    advancementCriteria: string[];
  };
  messages: Array<{
    direction: 'inbound' | 'outbound';
    content: string;
    timestamp: string;
    isAI: boolean;
  }>;
  organization: {
    id: string;
    name: string;
  };
}

/**
 * Build context for a deal (different from conversation-based context).
 * Fetches deal, contact, messages from associated conversation.
 */
async function buildDealContext(
  supabase: SupabaseClient,
  dealId: string
): Promise<DealContext | null> {
  // 1. Fetch deal with stage
  const { data: deal, error: dealError } = await supabase
    .from('deals')
    .select(`
      id,
      title,
      value,
      custom_fields,
      created_at,
      contact_id,
      organization_id,
      stage:board_stages!inner(
        id,
        name,
        board_id
      )
    `)
    .eq('id', dealId)
    .single();

  if (dealError || !deal) {
    console.error('[Briefing] Deal not found:', dealError);
    return null;
  }

  // 2. Fetch organization
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', deal.organization_id)
    .single();

  if (!org) {
    console.error('[Briefing] Organization not found');
    return null;
  }

  // 3. Fetch contact
  let contact: DealContext['contact'] = null;
  if (deal.contact_id) {
    const { data: contactData } = await supabase
      .from('contacts')
      .select('name, email, phone, company, position')
      .eq('id', deal.contact_id)
      .single();

    if (contactData) {
      contact = {
        name: contactData.name,
        email: contactData.email,
        phone: contactData.phone,
        company: contactData.company,
        position: contactData.position,
      };
    }
  }

  // 4. Find conversation for this deal
  const { data: conversations } = await supabase
    .from('messaging_conversations')
    .select('id')
    .contains('metadata', { deal_id: dealId })
    .limit(1);

  // 5. Fetch messages if conversation exists
  let messages: DealContext['messages'] = [];
  if (conversations && conversations.length > 0) {
    const { data: messagesData } = await supabase
      .from('messaging_messages')
      .select('direction, content, created_at, metadata')
      .eq('conversation_id', conversations[0].id)
      .order('created_at', { ascending: true })
      .limit(MAX_MESSAGES_FOR_BRIEFING);

    if (messagesData) {
      messages = messagesData.map((msg) => ({
        direction: msg.direction as 'inbound' | 'outbound',
        content: extractTextContent(msg.content as Record<string, unknown>),
        timestamp: msg.created_at,
        isAI: (msg.metadata as Record<string, unknown>)?.sent_by_ai === true,
      }));
    }
  }

  // 6. Fetch stage config
  const stageData = deal.stage as unknown as { id: string; name: string; board_id: string };
  const { data: stageConfig } = await supabase
    .from('stage_ai_config')
    .select('stage_goal, advancement_criteria')
    .eq('stage_id', stageData.id)
    .single();

  return {
    deal: {
      id: deal.id,
      title: deal.title,
      value: deal.value,
      stageName: stageData.name,
      createdAt: deal.created_at,
      customFields: (deal.custom_fields as Record<string, unknown>) || {},
    },
    contact,
    stage: {
      name: stageData.name,
      goal: stageConfig?.stage_goal || null,
      advancementCriteria: (stageConfig?.advancement_criteria as string[]) || [],
    },
    messages,
    organization: {
      id: org.id,
      name: org.name,
    },
  };
}

/**
 * Extract text from message content.
 */
function extractTextContent(content: Record<string, unknown>): string {
  if (typeof content === 'string') {
    return content;
  }

  if (content.text && typeof content.text === 'string') {
    return content.text;
  }

  if (content.type === 'image') return '[Imagem]';
  if (content.type === 'audio') return '[Áudio]';
  if (content.type === 'video') return '[Vídeo]';
  if (content.type === 'document') {
    return `[Documento: ${content.filename || 'arquivo'}]`;
  }

  return '[Mensagem]';
}

// =============================================================================
// Briefing Generation
// =============================================================================

/**
 * Format context as prompt text.
 */
function formatContextForPrompt(context: DealContext): string {
  const lines: string[] = [];

  // Deal info
  lines.push('## Informações do Deal');
  lines.push(`Título: ${context.deal.title}`);
  if (context.deal.value) {
    lines.push(`Valor: R$ ${context.deal.value.toLocaleString('pt-BR')}`);
  }
  lines.push(`Estágio: ${context.stage.name}`);
  lines.push(`Criado em: ${new Date(context.deal.createdAt).toLocaleDateString('pt-BR')}`);
  lines.push('');

  // Contact info
  lines.push('## Contato');
  if (context.contact) {
    if (context.contact.name) lines.push(`Nome: ${context.contact.name}`);
    if (context.contact.email) lines.push(`Email: ${context.contact.email}`);
    if (context.contact.phone) lines.push(`Telefone: ${context.contact.phone}`);
    if (context.contact.company) lines.push(`Empresa: ${context.contact.company}`);
    if (context.contact.position) lines.push(`Cargo: ${context.contact.position}`);
  } else {
    lines.push('Nenhum contato vinculado');
  }
  lines.push('');

  // Stage objective
  if (context.stage.goal) {
    lines.push('## Objetivo do Estágio');
    lines.push(context.stage.goal);
    lines.push('');
  }

  if (context.stage.advancementCriteria.length > 0) {
    lines.push('## Critérios para Avançar');
    context.stage.advancementCriteria.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }

  // Custom fields
  if (Object.keys(context.deal.customFields).length > 0) {
    lines.push('## Campos Customizados');
    for (const [key, value] of Object.entries(context.deal.customFields)) {
      if (value) {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push('');
  }

  // Messages
  lines.push('## Histórico de Conversas');
  if (context.messages.length === 0) {
    lines.push('Nenhuma mensagem registrada');
  } else {
    context.messages.forEach((msg) => {
      const role = msg.direction === 'inbound' ? 'LEAD' : msg.isAI ? 'AI' : 'VENDEDOR';
      const time = new Date(msg.timestamp).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      lines.push(`[${time}] ${role}: ${msg.content}`);
    });
  }

  return lines.join('\n');
}

/**
 * Generate a meeting briefing for a deal.
 *
 * @param dealId - The deal to generate briefing for
 * @param supabase - Authenticated Supabase client
 * @returns Complete briefing with BANT status and recommendations
 */
export async function generateMeetingBriefing(
  dealId: string,
  supabase: SupabaseClient
): Promise<BriefingResponse> {
  // 1. Build deal context
  const context = await buildDealContext(supabase, dealId);

  if (!context) {
    throw new Error('Deal not found or access denied');
  }

  // 2. Get AI config for organization
  const aiConfig = await getOrgAIConfig(supabase, context.organization.id);

  if (!aiConfig) {
    throw new Error('AI not configured for this organization. Please configure API keys in settings.');
  }

  if (!aiConfig.enabled) {
    throw new Error('AI is disabled for this organization.');
  }

  // 3. Format context for prompt
  const contextText = formatContextForPrompt(context);

  // 4. Generate briefing with structured output
  const model = getModel(aiConfig.provider, aiConfig.apiKey, aiConfig.model);

  const prompt = `Analise o contexto abaixo e gere um briefing COMPLETO EM PORTUGUÊS BRASILEIRO para a próxima conversa com este lead.

${contextText}

INSTRUÇÕES FINAIS:
- Gere o briefing estruturado seguindo o framework BANT
- Identifique pontos pendentes que precisam de follow-up
- Sugira abordagem e perguntas específicas
- TODO O CONTEÚDO DEVE ESTAR EM PORTUGUÊS BRASILEIRO
- Não use inglês em nenhum campo`;

  try {
    const result = await generateText({
      model,
      output: Output.object({
        schema: MeetingBriefingSchema,
        name: 'MeetingBriefing',
        description: 'Briefing estruturado pré-conversa com status BANT e recomendações',
      }),
      system: BRIEFING_SYSTEM_PROMPT,
      prompt,
      maxRetries: 2,
    });

    if (!result.output) {
      throw new Error('AI failed to generate structured output');
    }

    const briefing = result.output;

    return {
      ...briefing,
      generatedAt: new Date().toISOString(),
      basedOnMessages: context.messages.length,
      dealId,
    };
  } catch (error) {
    console.error('[Briefing] Error generating briefing:', error);
    throw new Error(
      `Failed to generate briefing: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
