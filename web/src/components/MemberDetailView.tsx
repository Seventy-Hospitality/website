import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Button,
  Tag,
  Text,
} from 'octahedron';
import { api } from '../lib/api';
import { MembershipStatus } from './MembershipStatus';
import { NotesList } from './NotesList';
import styles from './MemberDetailView.module.css';

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

export function MemberDetailView({ member, plans, onRefresh }: { member: Member; plans: Plan[]; onRefresh?: () => void }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState('');

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
      const data = await api.createCheckoutSession(member.id, planId);
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } finally {
      setLoading('');
    }
  }

  async function openPortal() {
    setLoading('portal');
    try {
      const data = await api.createPortalSession(member.id);
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } finally {
      setLoading('');
    }
  }

  async function syncFromStripe() {
    setLoading('sync');
    try {
      await api.syncMember(member.id);
      onRefresh?.();
    } finally {
      setLoading('');
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.headerGroup}>
        <button className={styles.back} onClick={() => navigate('/members')}>
          ← Members
        </button>
        <h1 className={styles.title}>
          {member.firstName} {member.lastName}
        </h1>
      </div>

      <div className={styles.grid}>
        <Card>
          <Text variant="label">Member Info</Text>
          <dl style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 'var(--octa-space-2)', margin: 'var(--octa-space-2) 0 0' }}>
            {memberRows.map((r) => (
              <Fragment key={r.label}>
                <dt style={{ color: 'var(--octa-muted)', fontSize: 'var(--octa-font-size-sm)' }}>{r.label}</dt>
                <dd style={{ margin: 0 }}>{r.value}</dd>
              </Fragment>
            ))}
          </dl>
        </Card>

        <Card>
          {member.membership ? (
            <div className={styles.membershipCard}>
              <Text variant="label">Membership</Text>
              <dl style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 'var(--octa-space-2)', margin: 'var(--octa-space-2) 0 0' }}>
                {membershipRows.map((r) => (
                  <Fragment key={r.label}>
                    <dt style={{ color: 'var(--octa-muted)', fontSize: 'var(--octa-font-size-sm)' }}>{r.label}</dt>
                    <dd style={{ margin: 0 }}>{r.value}</dd>
                  </Fragment>
                ))}
              </dl>
              <div className={styles.actions}>
                <Button
                  variant="soft"
                  onClick={openPortal}
                  loading={loading === 'portal'}
                >
                  Manage Billing
                </Button>
                <Button
                  variant="ghost"
                  onClick={syncFromStripe}
                  loading={loading === 'sync'}
                >
                  Sync from Stripe
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.noMembership}>
              <p className={styles.muted}>No active membership</p>
              <div className={styles.planButtons}>
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
            </div>
          )}
        </Card>
      </div>

      <Card>
        <NotesList memberId={member.id} initialNotes={member.notes} onNoteAdded={onRefresh} />
      </Card>
    </div>
  );
}
