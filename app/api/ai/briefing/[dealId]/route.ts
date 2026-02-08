/**
 * @fileoverview Meeting Briefing API
 *
 * GET /api/ai/briefing/[dealId]
 * Generates a pre-meeting briefing for a deal.
 *
 * @module app/api/ai/briefing/[dealId]/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateMeetingBriefing } from '@/lib/ai/briefing/briefing.service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dealId: string }> }
) {
  const { dealId } = await params;

  if (!dealId) {
    return NextResponse.json(
      { error: 'dealId is required' },
      { status: 400 }
    );
  }

  try {
    const supabase = await createClient();

    // Verify authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Verify user has access to this deal (RLS will handle this, but let's be explicit)
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, organization_id')
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return NextResponse.json(
        { error: 'Deal not found or access denied' },
        { status: 404 }
      );
    }

    // Generate briefing
    const briefing = await generateMeetingBriefing(dealId, supabase);

    return NextResponse.json(briefing);
  } catch (error) {
    console.error('[Briefing API] Error:', error);

    const message = error instanceof Error ? error.message : 'Failed to generate briefing';
    const isConfigError = message.includes('not configured') || message.includes('disabled');

    return NextResponse.json(
      { error: message },
      { status: isConfigError ? 400 : 500 }
    );
  }
}
