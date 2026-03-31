import { Fragment, useEffect, useState } from 'react';
import {
  Button,
  Tag,
  Text,
} from 'octahedron';
import { api } from '../lib/api';
import { MembershipStatus } from './MembershipStatus';
import { NotesList } from './NotesList';

interface Plan {
  id: string;
  name: string;
  amountCents: number;
  interval: string;
}

interface Member {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  stripeCustomerId: string | null;
  membership: {
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    plan: { name: string; amountCents: number; interval: string };
  } | null;
  notes: Array<{
    id: string;
    content: string;
    authorId: string;
    createdAt: string;
  }>;
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface Props {
  memberId: string;
}

export function MemberInspector({ memberId }: Props) {
  const [member, setMember] = useState<Member | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState('');

  function reload() {
    api.getMember(memberId).then(setMember);
  }

  useEffect(() => {
    Promise.all([api.getMember(memberId), api.listPlans()])
      .then(([m, p]) => { setMember(m); setPlans(p ?? []); });
  }, [memberId]);

  if (!member) return null;

  const memberRows = [
    { label: 'Email', value: member.email },
    { label: 'Phone', value: member.phone ?? '—' },
  ];

  const membershipRows = member.membership
    ? [
        { label: 'Plan', value: member.membership.plan.name },
        {
          label: 'Amount',
          value: `${formatCurrency(member.membership.plan.amountCents)}/${member.membership.plan.interval}`,
        },
        { label: 'Status', value: <MembershipStatus status={member.membership.status} /> },
        {
          label: 'Period End',
          value: new Date(member.membership.currentPeriodEnd).toLocaleDateString(),
        },
        ...(member.membership.cancelAtPeriodEnd
          ? [{ label: 'Canceling', value: <Tag variant={'warning' as const}>Cancels at period end</Tag> }]
          : []),
      ]
    : [];

  async function startCheckout(planId: string) {
    setLoading('checkout');
    try {
      const data = await api.createCheckoutSession(member!.id, planId);
      if (data?.url) window.open(data.url, '_blank');
    } finally {
      setLoading('');
    }
  }

  async function openPortal() {
    setLoading('portal');
    try {
      const data = await api.createPortalSession(member!.id);
      if (data?.url) window.open(data.url, '_blank');
    } finally {
      setLoading('');
    }
  }

  async function syncFromStripe() {
    setLoading('sync');
    try {
      await api.syncMember(member!.id);
      reload();
    } finally {
      setLoading('');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--octa-space-4)', padding: 'var(--octa-space-4)' }}>
      <div>
        <Text variant="label">Member Info</Text>
        <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 'var(--octa-space-2)', margin: 'var(--octa-space-2) 0 0' }}>
          {memberRows.map((r) => (
            <Fragment key={r.label}>
              <dt style={{ color: 'var(--octa-muted)', fontSize: 'var(--octa-font-size-sm)' }}>{r.label}</dt>
              <dd style={{ margin: 0 }}>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
      </div>

      {member.membership ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--octa-space-3)' }}>
          <div>
            <Text variant="label">Membership</Text>
            <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 'var(--octa-space-2)', margin: 'var(--octa-space-2) 0 0' }}>
              {membershipRows.map((r) => (
                <Fragment key={r.label}>
                  <dt style={{ color: 'var(--octa-muted)', fontSize: 'var(--octa-font-size-sm)' }}>{r.label}</dt>
                  <dd style={{ margin: 0 }}>{r.value}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
          <div style={{ display: 'flex', gap: 'var(--octa-space-2)' }}>
            <Button variant="soft" onClick={openPortal} loading={loading === 'portal'}>
              Manage Billing
            </Button>
            <Button variant="ghost" onClick={syncFromStripe} loading={loading === 'sync'}>
              Sync
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--octa-space-3)' }}>
          <Text intent="muted">No active membership</Text>
          {plans.map((plan) => (
            <Button
              key={plan.id}
              color="primary"
              onClick={() => startCheckout(plan.id)}
              loading={loading === 'checkout'}
            >
              Start {plan.name} — {formatCurrency(plan.amountCents)}/{plan.interval}
            </Button>
          ))}
        </div>
      )}

      <NotesList memberId={member.id} initialNotes={member.notes} onNoteAdded={reload} />
    </div>
  );
}
